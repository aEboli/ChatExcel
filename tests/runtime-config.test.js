import assert from "node:assert/strict";
import test from "node:test";
import {
  inferReasoningEfforts,
  parseModelCatalog,
  RuntimeConfigError,
  RuntimeConfigStore,
} from "../src/server/runtime-config.js";

function systemConfig() {
  return {
    configPath: "config.toml",
    providerId: "system",
    providerName: "System Provider",
    model: "gpt-5-system",
    baseUrl: "https://provider.example/v1",
    responsesUrl: "https://provider.example/v1/responses",
    wireApi: "responses",
    reasoningEffort: "high",
    verbosity: "medium",
    contextWindow: 200000,
    token: "system-secret",
    tokenSource: "config",
  };
}

function memorySettingsStore(initial = {}) {
  let value = structuredClone(initial);
  return {
    async load() { return structuredClone(value); },
    async save(payload) {
      value = structuredClone(payload);
      if (value.custom?.apiKey) {
        value.custom.encryptedApiKey = `cipher:${value.custom.apiKey}`;
        delete value.custom.apiKey;
      }
    },
    async decryptCustom(custom) {
      return typeof custom?.encryptedApiKey === "string"
        ? custom.encryptedApiKey.replace(/^cipher:/, "")
        : null;
    },
    get value() { return structuredClone(value); },
  };
}

test("解析提供方思考等级并为缺失元数据的模型推断", () => {
  const models = parseModelCatalog({
    data: [
      { id: "gpt-5-declared", supported_reasoning_efforts: ["low", "high"] },
      { id: "plain-chat" },
    ],
  });

  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);
  assert.equal(models[0].reasoningSource, "provider");
  assert.deepEqual(models[1].reasoningEfforts, ["none"]);
  assert.equal(inferReasoningEfforts("gpt-5-test").includes("max"), true);
});

test("系统状态脱敏且只暴露当前模型作为初始选择", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  const state = await store.getPublicState();
  const serialized = JSON.stringify(state);

  assert.equal(state.source, "system");
  assert.equal(state.config.model, "gpt-5-system");
  assert.equal(state.models[0].id, "gpt-5-system");
  assert.equal(serialized.includes("system-secret"), false);
});

test("发现自定义模型后保存内存配置并校验消息级选择", async () => {
  let request;
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async (url, options) => {
      request = { url, authorization: options.headers.Authorization };
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-5-custom", reasoning_efforts: ["low", "medium", "high"] },
          { id: "gpt-5-backup" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    settingsStore: memorySettingsStore(),
  });

  await store.discoverModels({
    useSystemConfig: false,
    apiUrl: "https://custom.example/v1/",
    apiKey: "custom-secret",
  });
  const state = await store.update({
    useSystemConfig: false,
    apiUrl: "https://custom.example/v1",
    apiKey: "custom-secret",
    model: "gpt-5-custom",
    contextWindow: 128000,
    reasoningEffort: "high",
  });
  const selected = await store.loadConfig({ model: "gpt-5-backup", reasoningEffort: "max" });

  assert.equal(request.url, "https://custom.example/v1/models");
  assert.equal(request.authorization, "Bearer custom-secret");
  assert.equal(state.source, "custom");
  assert.equal(state.settings.apiUrl, "https://custom.example");
  assert.equal(JSON.stringify(state).includes("custom-secret"), false);
  assert.equal(selected.model, "gpt-5-backup");
  assert.equal(selected.reasoningEffort, "max");
});

test("未获取模型时拒绝保存自定义配置", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    settingsStore: memorySettingsStore(),
  });

  await assert.rejects(
    () => store.update({
      useSystemConfig: false,
      apiUrl: "https://custom.example/v1",
      apiKey: "secret",
      model: "gpt-test",
      contextWindow: 128000,
      reasoningEffort: "low",
    }),
    (error) => error instanceof RuntimeConfigError && error.code === "MODELS_NOT_DISCOVERED",
  );
});

test("最大步骤数默认 100、可持久化并在重启后恢复", async () => {
  const settingsStore = memorySettingsStore({ version: 1, useSystemConfig: true, maxSteps: 37 });
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore,
  });
  assert.equal((await store.getPublicState()).settings.maxSteps, 37);

  await store.update({ useSystemConfig: true, maxSteps: 222 });
  assert.equal(settingsStore.value.maxSteps, 222);
  assert.equal((await store.getPublicState()).settings.maxSteps, 222);

  const restarted = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore,
  });
  assert.equal((await restarted.getPublicState()).settings.maxSteps, 222);
});

test("最大步骤数拒绝超出安全范围的值", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });
  await assert.rejects(
    () => store.update({ useSystemConfig: true, maxSteps: 1001 }),
    (error) => error instanceof RuntimeConfigError && error.code === "MAX_STEPS_INVALID",
  );
});

test("自定义 Anthropic 配置和模型目录在重启及模式切换后恢复", async () => {
  const settingsStore = memorySettingsStore();
  const fetchImpl = async () => new Response(JSON.stringify({
    data: [{ id: "claude-sonnet", supported_reasoning_efforts: ["low", "high"] }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const first = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl,
    settingsStore,
  });
  await first.discoverModels({
    useSystemConfig: false,
    protocol: "anthropic-messages",
    apiUrl: "https://api.example.com/v1/messages",
    apiKey: "anthropic-secret",
  });
  await first.update({
    useSystemConfig: false,
    protocol: "anthropic-messages",
    apiUrl: "https://api.example.com",
    apiKey: "anthropic-secret",
    model: "claude-sonnet",
    contextWindow: 200000,
    reasoningEffort: "high",
    maxSteps: 144,
  });

  const restarted = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl,
    settingsStore,
  });
  const restored = await restarted.getPublicState();
  assert.equal(restored.source, "custom");
  assert.equal(restored.config.protocol, "anthropic-messages");
  assert.equal(restored.config.endpoint, "https://api.example.com/v1/messages");
  assert.equal(restored.settings.maxSteps, 144);
  assert.equal(JSON.stringify(restored).includes("anthropic-secret"), false);

  await restarted.update({ useSystemConfig: true, maxSteps: 144 });
  const systemState = await restarted.getPublicState();
  assert.equal(systemState.source, "system");
  assert.equal(systemState.settings.protocol, "anthropic-messages");
  assert.equal(systemState.settings.models[0].id, "claude-sonnet");
});
