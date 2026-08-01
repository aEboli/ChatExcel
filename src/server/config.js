import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class ConfigError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
  }
}

function requiredString(value, code, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(code, message);
  }
  return value.trim();
}

function optionalEnum(value, allowed, code, message) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ConfigError(code, message);
  }
  return value;
}

function optionalPositiveInteger(value, fallback, code, message) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 2_000_000) {
    throw new ConfigError(code, message);
  }
  return value;
}

export function buildResponsesUrl(rawBaseUrl, queryParams) {
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch (error) {
    throw new ConfigError("CONFIG_BASE_URL_INVALID", "当前提供方的 base_url 不是有效 URL。", {
      cause: error,
    });
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new ConfigError("CONFIG_BASE_URL_INVALID", "当前提供方的 base_url 仅支持 HTTP 或 HTTPS。" );
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError(
      "CONFIG_BASE_URL_INVALID",
      "当前提供方的 base_url 不能包含凭据、查询参数或片段。",
    );
  }

  const baseUrl = parsed.toString().replace(/\/+$/, "");
  const responsesUrl = new URL(`${baseUrl}/responses`);

  if (queryParams !== undefined) {
    if (queryParams === null || typeof queryParams !== "object" || Array.isArray(queryParams)) {
      throw new ConfigError("CONFIG_QUERY_PARAMS_INVALID", "当前提供方的 query_params 必须是键值表。" );
    }

    for (const [key, value] of Object.entries(queryParams)) {
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new ConfigError(
          "CONFIG_QUERY_PARAMS_INVALID",
          `query_params.${key} 必须是字符串、数字或布尔值。`,
        );
      }
      responsesUrl.searchParams.set(key, String(value));
    }
  }

  return { baseUrl, responsesUrl: responsesUrl.toString() };
}

function resolveToken(provider, env) {
  if (provider.env_key !== undefined) {
    const envKey = requiredString(
      provider.env_key,
      "CONFIG_ENV_KEY_INVALID",
      "当前提供方的 env_key 不能为空。",
    );
    const token = env[envKey];
    if (typeof token !== "string" || token.trim() === "") {
      throw new ConfigError(
        "CONFIG_TOKEN_MISSING",
        `当前提供方声明的环境变量 ${envKey} 未设置。`,
      );
    }
    return { token: token.trim(), tokenSource: "environment" };
  }

  if (
    typeof provider.experimental_bearer_token !== "string" ||
    provider.experimental_bearer_token.trim() === ""
  ) {
    throw new ConfigError("CONFIG_TOKEN_MISSING", "当前提供方未配置可用的模型令牌。" );
  }

  return {
    token: provider.experimental_bearer_token.trim(),
    tokenSource: "config",
  };
}

export function resolveCodexConfigPath({ env = process.env, homeDir = homedir() } = {}) {
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() !== ""
      ? env.CODEX_HOME.trim()
      : join(homeDir, ".codex");
  return join(codexHome, "config.toml");
}

export function parseCodexConfig(source, { env = process.env, configPath = "config.toml" } = {}) {
  let document;
  try {
    document = parse(source);
  } catch (error) {
    throw new ConfigError("CONFIG_TOML_INVALID", "Codex config.toml 无法解析。", {
      cause: error,
    });
  }

  const providerId = requiredString(
    document.model_provider,
    "CONFIG_PROVIDER_MISSING",
    "Codex 配置未选择 model_provider。",
  );
  const model = requiredString(
    document.model,
    "CONFIG_MODEL_MISSING",
    "Codex 配置未选择 model。",
  );
  const providers = document.model_providers;
  const provider =
    providers && typeof providers === "object" && !Array.isArray(providers)
      ? providers[providerId]
      : undefined;

  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new ConfigError(
      "CONFIG_PROVIDER_UNKNOWN",
      `Codex 配置中不存在 model_providers.${providerId}。`,
    );
  }

  if (provider.wire_api !== "responses") {
    throw new ConfigError(
      "CONFIG_WIRE_API_UNSUPPORTED",
      "当前提供方必须显式配置 wire_api = \"responses\"。",
    );
  }

  const rawBaseUrl = requiredString(
    provider.base_url,
    "CONFIG_BASE_URL_MISSING",
    "当前提供方未配置 base_url。",
  );
  const { baseUrl, responsesUrl } = buildResponsesUrl(rawBaseUrl, provider.query_params);
  const { token, tokenSource } = resolveToken(provider, env);
  const reasoningEffort = optionalEnum(
    document.model_reasoning_effort,
    REASONING_EFFORTS,
    "CONFIG_REASONING_EFFORT_INVALID",
    "Codex 配置中的 model_reasoning_effort 无效。",
  );
  const verbosity = optionalEnum(
    document.model_verbosity,
    ["low", "medium", "high"],
    "CONFIG_VERBOSITY_INVALID",
    "Codex 配置中的 model_verbosity 无效。",
  );
  const contextWindow = optionalPositiveInteger(
    document.model_context_window,
    DEFAULT_CONTEXT_WINDOW,
    "CONFIG_CONTEXT_WINDOW_INVALID",
    "Codex 配置中的 model_context_window 必须是 1024 到 2000000 之间的整数。",
  );

  return Object.freeze({
    configPath,
    providerId,
    providerName:
      typeof provider.name === "string" && provider.name.trim() !== ""
        ? provider.name.trim()
        : providerId,
    model,
    baseUrl,
    responsesUrl,
    endpoint: responsesUrl,
    protocol: "openai-responses",
    wireApi: "responses",
    reasoningEffort,
    verbosity,
    contextWindow,
    token,
    tokenSource,
  });
}

export async function loadCodexConfig({ env = process.env, homeDir = homedir() } = {}) {
  const configPath = resolveCodexConfigPath({ env, homeDir });
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ConfigError("CONFIG_FILE_UNREADABLE", "无法读取当前用户的 Codex config.toml。", {
      cause: error,
    });
  }
  return parseCodexConfig(source, { env, configPath });
}

export function toPublicConfig(config) {
  const endpoint = new URL(config.endpoint ?? config.responsesUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";

  return {
    providerId: config.providerId,
    providerName: config.providerName,
    model: config.model,
    endpoint: endpoint.toString(),
    protocol: config.protocol ?? "openai-responses",
    wireApi: config.wireApi,
    reasoningEffort: config.reasoningEffort,
    verbosity: config.verbosity,
    contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    credentialConfigured: Boolean(config.token),
    tokenSource: config.tokenSource,
  };
}
