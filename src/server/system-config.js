import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadCodexConfig } from "./config.js";
import { buildProtocolEndpoints } from "./protocols.js";

export const SYSTEM_CONFIG_SOURCES = Object.freeze([
  Object.freeze({ id: "auto", label: "自动（优先 Codex CLI）" }),
  Object.freeze({ id: "codex", label: "Codex CLI" }),
  Object.freeze({ id: "claude", label: "Claude CLI" }),
]);

export const DEFAULT_SYSTEM_CONFIG_SOURCE = "auto";

export function isSystemConfigSource(value) {
  return SYSTEM_CONFIG_SOURCES.some((source) => source.id === value);
}

export function resolveClaudeConfigPath({ homeDir = homedir() } = {}) {
  return join(homeDir, ".claude", "settings.json");
}

function requiredString(value, code, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(code, message);
  }
  return value.trim();
}

function parseJson(source, configPath) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ConfigError("CLAUDE_CONFIG_INVALID", "Claude CLI settings.json 无法解析。", {
      cause: error,
    });
  }
}

export function parseClaudeConfig(source, { configPath = "settings.json" } = {}) {
  const document = parseJson(source, configPath);
  const env = document?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new ConfigError("CLAUDE_ENV_MISSING", "Claude CLI 配置未声明 env 配置。" );
  }
  const baseUrl = requiredString(
    env.ANTHROPIC_BASE_URL,
    "CLAUDE_BASE_URL_MISSING",
    "Claude CLI 配置未声明 ANTHROPIC_BASE_URL。",
  );
  const token = requiredString(
    env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY,
    "CLAUDE_TOKEN_MISSING",
    "Claude CLI 配置未声明可用的 Anthropic 令牌。",
  );
  const model = requiredString(
    document.model ?? env.ANTHROPIC_MODEL,
    "CLAUDE_MODEL_MISSING",
    "Claude CLI 配置未声明模型。",
  );
  const endpoints = buildProtocolEndpoints("anthropic-messages", baseUrl, model);
  return Object.freeze({
    configPath,
    cliSource: "claude",
    providerId: "claude-cli",
    providerName: "Claude CLI",
    model,
    baseUrl: endpoints.baseUrl,
    endpoint: endpoints.endpoint,
    responsesUrl: null,
    protocol: "anthropic-messages",
    wireApi: "messages",
    reasoningEffort: typeof env.CLAUDE_CODE_EFFORT_LEVEL === "string"
      ? env.CLAUDE_CODE_EFFORT_LEVEL.trim() || null
      : null,
    verbosity: null,
    contextWindow: 200_000,
    contextWindowConfigured: false,
    token,
    tokenSource: "claude-settings",
  });
}

export async function loadClaudeConfig({ homeDir = homedir() } = {}) {
  const configPath = resolveClaudeConfigPath({ homeDir });
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ConfigError("CLAUDE_CONFIG_UNREADABLE", "无法读取当前用户的 Claude CLI settings.json。", {
      cause: error,
    });
  }
  return parseClaudeConfig(source, { configPath });
}

export async function loadSystemConfig({ source = DEFAULT_SYSTEM_CONFIG_SOURCE, ...options } = {}) {
  if (!isSystemConfigSource(source)) {
    throw new ConfigError("SYSTEM_CONFIG_SOURCE_INVALID", "系统 CLI 配置来源无效。" );
  }
  if (source === "codex") return loadCodexConfig(options);
  if (source === "claude") return loadClaudeConfig(options);

  try {
    return await loadCodexConfig(options);
  } catch (codexError) {
    try {
      return await loadClaudeConfig(options);
    } catch (claudeError) {
      throw new ConfigError(
        typeof codexError?.code === "string" ? codexError.code : "SYSTEM_CONFIG_UNAVAILABLE",
        codexError instanceof Error ? codexError.message : "本机 CLI 配置不可用。",
        { cause: claudeError },
      );
    }
  }
}
