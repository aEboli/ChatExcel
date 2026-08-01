import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_STEPS, normalizeMaxSteps } from "./limits.js";

export const DEFAULT_SETTINGS_PATH = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "ChatExcel",
  "settings.json",
);

export class SettingsStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SettingsStoreError";
    this.code = code;
  }
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new SettingsStoreError("DPAPI_UNAVAILABLE", "Windows DPAPI 不可用。", {
          cause: new Error(stderr.trim().slice(0, 300)),
        }));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(input, "utf8");
  });
}

export function protectWithWindowsDpapi(secret) {
  if (process.platform !== "win32") {
    return Promise.reject(new SettingsStoreError("DPAPI_UNAVAILABLE", "当前系统不是 Windows。"));
  }
  return runPowerShell(
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)",
    secret,
  );
}

export async function unprotectWithWindowsDpapi(ciphertext) {
  if (process.platform !== "win32") {
    throw new SettingsStoreError("DPAPI_UNAVAILABLE", "当前系统不是 Windows。" );
  }
  const plaintext = await runPowerShell(
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($s.Trim());$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($p)",
    ciphertext,
  );
  if (plaintext === "") {
    throw new SettingsStoreError("DPAPI_EMPTY", "DPAPI 返回了空凭据。" );
  }
  return plaintext;
}

function assertObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SettingsStore {
  constructor({
    settingsPath = DEFAULT_SETTINGS_PATH,
    protectSecret = protectWithWindowsDpapi,
    unprotectSecret = unprotectWithWindowsDpapi,
  } = {}) {
    if (typeof settingsPath !== "string" || settingsPath.trim() === "") {
      throw new TypeError("settingsPath 必须是非空路径。" );
    }
    if (typeof protectSecret !== "function" || typeof unprotectSecret !== "function") {
      throw new TypeError("SettingsStore 需要 DPAPI 保护函数。" );
    }
    this.settingsPath = settingsPath;
    this.protectSecret = protectSecret;
    this.unprotectSecret = unprotectSecret;
  }

  async load() {
    let source;
    try {
      source = await readFile(this.settingsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new SettingsStoreError("SETTINGS_READ_FAILED", "无法读取 ChatExcel 本地配置。", { cause: error });
    }
    let value;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new SettingsStoreError("SETTINGS_INVALID", "ChatExcel 本地配置不是有效 JSON。", { cause: error });
    }
    if (!assertObject(value) || (value.version !== undefined && value.version !== 1)) {
      throw new SettingsStoreError("SETTINGS_INVALID", "ChatExcel 本地配置格式不受支持。" );
    }
    return value;
  }

  async save({ useSystemConfig, custom, maxSteps = DEFAULT_MAX_STEPS }) {
    if (typeof useSystemConfig !== "boolean" || (custom !== null && !assertObject(custom))) {
      throw new SettingsStoreError("SETTINGS_INVALID", "要保存的 ChatExcel 配置格式无效。" );
    }
    let normalizedMaxSteps;
    try {
      normalizedMaxSteps = normalizeMaxSteps(maxSteps, { ErrorClass: SettingsStoreError });
    } catch (error) {
      if (error instanceof SettingsStoreError) throw error;
      throw new SettingsStoreError("MAX_STEPS_INVALID", "最大步骤数配置无效。", { cause: error });
    }
    let encryptedApiKey = custom?.encryptedApiKey;
    if (typeof custom?.apiKey === "string" && custom.apiKey.trim() !== "") {
      encryptedApiKey = await this.protectSecret(custom.apiKey.trim());
    }
    if (custom && (typeof encryptedApiKey !== "string" || encryptedApiKey.trim() === "")) {
      throw new SettingsStoreError("API_KEY_REQUIRED", "保存自定义配置时必须提供 API Key。" );
    }
    const payload = {
      version: 1,
      useSystemConfig,
      maxSteps: normalizedMaxSteps,
      custom: custom
        ? {
            protocol: custom.protocol,
            apiUrl: custom.apiUrl,
            encryptedApiKey,
            model: custom.model,
            contextWindow: custom.contextWindow,
            reasoningEffort: custom.reasoningEffort ?? null,
            catalog: Array.isArray(custom.catalog) ? custom.catalog : [],
          }
        : null,
    };
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.settingsPath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    return payload;
  }

  async decryptCustom(value) {
    if (!assertObject(value) || typeof value.encryptedApiKey !== "string") {
      return null;
    }
    try {
      return await this.unprotectSecret(value.encryptedApiKey);
    } catch (error) {
      throw new SettingsStoreError("DPAPI_UNAVAILABLE", "无法解密 ChatExcel 自定义 API Key。", {
        cause: error,
      });
    }
  }
}
