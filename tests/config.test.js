import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigError,
  loadCodexConfig,
  parseCodexConfig,
  resolveCodexAuthPath,
  resolveCodexConfigPath,
  toPublicConfig,
} from "../src/server/config.js";

const directTokenConfig = `
model_provider = "custom"
model = "gpt-test"
model_reasoning_effort = "high"
model_verbosity = "low"
model_context_window = 160000

[model_providers.custom]
name = "Local Provider"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
experimental_bearer_token = "test-secret"

[model_providers.custom.query_params]
region = "local"
`;

test("解析自定义 Responses 提供方并构造接口", () => {
  const config = parseCodexConfig(directTokenConfig, { env: {} });

  assert.equal(config.providerId, "custom");
  assert.equal(config.providerName, "Local Provider");
  assert.equal(config.model, "gpt-test");
  assert.equal(config.reasoningEffort, "high");
  assert.equal(config.verbosity, "low");
  assert.equal(config.contextWindow, 160000);
  assert.equal(config.contextWindowConfigured, true);
  assert.equal(config.responsesUrl, "http://127.0.0.1:8080/v1/responses?region=local");
  assert.equal(config.token, "test-secret");
  assert.equal(config.tokenSource, "config");
});

test("优先使用 env_key 声明的环境变量", () => {
  const source = `
model_provider = "custom"
model = "gpt-test"
[model_providers.custom]
base_url = "https://api.example.test/v1"
wire_api = "responses"
env_key = "LOCAL_MODEL_TOKEN"
experimental_bearer_token = "must-not-be-used"
`;

  const config = parseCodexConfig(source, {
    env: { LOCAL_MODEL_TOKEN: "environment-secret" },
  });

  assert.equal(config.token, "environment-secret");
  assert.equal(config.tokenSource, "environment");
  assert.equal(config.contextWindowConfigured, false);
});

test("环境变量令牌缺失时失败关闭", () => {
  const source = `
model_provider = "custom"
model = "gpt-test"
[model_providers.custom]
base_url = "https://api.example.test"
wire_api = "responses"
env_key = "MISSING_MODEL_TOKEN"
`;

  assert.throws(
    () => parseCodexConfig(source, { env: {} }),
    (error) => error instanceof ConfigError && error.code === "CONFIG_TOKEN_MISSING",
  );
});

test("Codex CLI provider 使用 auth.json 中的 OPENAI_API_KEY", () => {
  const source = `
model_provider = "custom"
model = "gpt-test"
[model_providers.custom]
base_url = "http://127.0.0.1:8080"
wire_api = "responses"
requires_openai_auth = true
`;

  const config = parseCodexConfig(source, {
    env: {},
    auth: { OPENAI_API_KEY: "codex-auth-secret" },
  });

  assert.equal(config.token, "codex-auth-secret");
  assert.equal(config.tokenSource, "codex-auth");
});

test("拒绝非 Responses 协议", () => {
  const source = `
model_provider = "custom"
model = "gpt-test"
[model_providers.custom]
base_url = "https://api.example.test"
wire_api = "chat"
experimental_bearer_token = "test-secret"
`;

  assert.throws(
    () => parseCodexConfig(source, { env: {} }),
    (error) => error instanceof ConfigError && error.code === "CONFIG_WIRE_API_UNSUPPORTED",
  );
});

test("脱敏状态不包含令牌或查询参数", () => {
  const publicConfig = toPublicConfig(parseCodexConfig(directTokenConfig, { env: {} }));
  const serialized = JSON.stringify(publicConfig);

  assert.equal(publicConfig.endpoint, "http://127.0.0.1:8080/v1/responses");
  assert.equal(publicConfig.credentialConfigured, true);
  assert.equal(publicConfig.reasoningEffort, "high");
  assert.equal(publicConfig.verbosity, "low");
  assert.equal(publicConfig.contextWindow, 160000);
  assert.equal(serialized.includes("test-secret"), false);
  assert.equal(serialized.includes("region=local"), false);
});

test("从 CODEX_HOME 读取配置文件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excel-local-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "config.toml"), directTokenConfig, "utf8");

  const config = await loadCodexConfig({ env: { CODEX_HOME: directory } });

  assert.equal(config.configPath, join(directory, "config.toml"));
  assert.equal(resolveCodexConfigPath({ env: { CODEX_HOME: directory } }), config.configPath);
  assert.equal(resolveCodexAuthPath({ env: { CODEX_HOME: directory } }), join(directory, "auth.json"));
});

test("从 Codex auth.json 恢复 CLI 凭据", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "excel-codex-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `
model_provider = "custom"
model = "gpt-test"
[model_providers.custom]
base_url = "http://127.0.0.1:8080"
wire_api = "responses"
requires_openai_auth = true
`;
  await writeFile(join(directory, "config.toml"), source, "utf8");
  await writeFile(join(directory, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "codex-auth-secret" }), "utf8");

  const config = await loadCodexConfig({ env: { CODEX_HOME: directory } });

  assert.equal(config.token, "codex-auth-secret");
  assert.equal(config.tokenSource, "codex-auth");
});
