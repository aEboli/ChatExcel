import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("保留提供方已声明思考等级，不将兼容档位混入已证实能力", () => {
  const models = parseModelCatalog({
    data: [
      { id: "gpt-5-declared", supported_reasoning_efforts: ["low", "high"] },
    ],
  });

  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);
  assert.equal(models[0].reasoningSource, "provider");
  assert.deepEqual(models[0].compatibleReasoningEfforts, []);
});

test("官方目录为 Qwen3.7 Max Chat Completions 提供自动和关闭开关", () => {
  const [model] = parseModelCatalog({
    data: [{
      id: "qwen3.7-max",
      context_window: 200000,
      reasoning_efforts: ["low", "high"],
    }],
  }, "openai-chat-completions");

  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.contextSource, "official");
  assert.equal(model.reasoningSource, "official");
  assert.equal(model.reasoningMode, "thinking-toggle");
  assert.deepEqual(model.reasoningEfforts, ["none"]);
  assert.deepEqual(model.compatibleReasoningEfforts, []);
  assert.equal(model.defaultReasoningEffort, null);
  assert.equal(model.thinkingToggle, true);
  assert.equal(model.capabilityReference, "https://help.aliyun.com/zh/model-studio/qwen3-7-max.md");
  assert.deepEqual(model.capabilityReferences, [
    "https://help.aliyun.com/zh/model-studio/qwen3-7-max.md",
    "https://help.aliyun.com/zh/model-studio/deep-thinking.md",
  ]);
});

test("官方目录为 Qwen3.7 Max Responses 提供公布的思考等级", () => {
  const [model] = parseModelCatalog({ data: [{ id: "qwen3.7-max" }] }, "openai-responses");

  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.contextSource, "official");
  assert.equal(model.reasoningSource, "official");
  assert.equal(model.reasoningMode, "levels");
  assert.deepEqual(model.reasoningEfforts, ["none", "minimal", "low", "medium", "high"]);
  assert.deepEqual(model.compatibleReasoningEfforts, []);
  assert.equal(model.defaultReasoningEffort, "medium");
  assert.equal(model.thinkingToggle, undefined);
});

test("未知 OpenAI 模型仅返回 ID 时使用独立兼容档位", () => {
  for (const protocol of ["openai-responses", "openai-chat-completions"]) {
    const [model] = parseModelCatalog({ data: [{ id: "gateway-unknown" }] }, protocol);

    assert.deepEqual(model.reasoningEfforts, [], protocol);
    assert.deepEqual(model.compatibleReasoningEfforts, ["low", "medium", "high"], protocol);
    assert.equal(model.defaultReasoningEffort, null, protocol);
    assert.notEqual(model.reasoningSource, "inferred", protocol);
  }
});

test("官方目录补全 DeepSeek V4 的上下文和实际思考档位", () => {
  const models = parseModelCatalog({
    data: [
      { id: "deepseek-v4-flash", context_window: 32_000, reasoning_efforts: ["none"] },
      { id: "deepseek-v4-pro", context_window: 32_000, reasoning_efforts: ["low"] },
    ],
  }, "openai-chat-completions");
  const byId = new Map(models.map((model) => [model.id, model]));

  assert.equal(byId.get("deepseek-v4-flash").contextWindow, 1_000_000);
  assert.equal(byId.get("deepseek-v4-flash").contextSource, "official");
  assert.equal(byId.get("deepseek-v4-flash").maxOutputLabel, "384K");
  assert.equal(byId.get("deepseek-v4-flash").maxOutputSource, "official");
  assert.deepEqual(byId.get("deepseek-v4-flash").reasoningEfforts, ["none", "low", "high", "max"]);
  assert.equal(byId.get("deepseek-v4-flash").defaultReasoningEffort, "high");
  assert.equal(byId.get("deepseek-v4-flash").reasoningSource, "official");
  assert.equal(byId.get("deepseek-v4-pro").contextWindow, 1_000_000);
  assert.equal(byId.get("deepseek-v4-pro").maxOutputLabel, "384K");
  assert.equal(byId.get("deepseek-v4-pro").maxOutputSource, "official");
  assert.deepEqual(byId.get("deepseek-v4-pro").reasoningEfforts, ["none", "high", "max"]);
  assert.equal(byId.get("deepseek-v4-pro").defaultReasoningEffort, "high");
  assert.equal(
    byId.get("deepseek-v4-flash").capabilityReference,
    "https://api-docs.deepseek.com/api/list-models",
  );
});

test("官方目录只匹配已核验的模型 ID", () => {
  const models = parseModelCatalog({
    data: [
      { id: "qwen3.7-max-2026-05-20" },
      { id: "qwen3.7-max-preview" },
      { id: "qwen3.7-max-2026-05-17" },
      { id: "gpt-5.4-mini" },
      { id: "deepseek-v4-flash-preview" },
      { id: "deepseek-v4-flash-0731" },
    ],
  }, "openai-chat-completions");
  const byId = new Map(models.map((model) => [model.id, model]));

  assert.equal(byId.get("qwen3.7-max-2026-05-20").contextSource, "official");
  assert.equal(byId.get("qwen3.7-max-2026-05-20").reasoningMode, "thinking-toggle");
  assert.equal(byId.get("qwen3.7-max-preview").contextSource, undefined);
  assert.equal(byId.get("qwen3.7-max-2026-05-17").contextSource, undefined);
  assert.equal(byId.get("gpt-5.4-mini").contextSource, undefined);
  assert.equal(byId.get("deepseek-v4-flash-preview").contextSource, undefined);
  assert.equal(byId.get("deepseek-v4-flash-0731").contextSource, undefined);
  assert.equal(byId.get("deepseek-v4-flash-0731").maxOutputLabel, undefined);
  assert.equal(byId.get("deepseek-v4-flash-0731").maxOutputSource, undefined);
});

test("DeepSeek V4 Flash 的默认值和会话级思考选择都由官方目录校验", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "deepseek-v4-flash",
      protocol: "openai-chat-completions",
      endpoint: "https://provider.example/v1/chat/completions",
      reasoningEffort: "none",
      contextWindowConfigured: false,
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  const state = await store.getPublicState();
  const disabled = await store.loadConfig({ reasoningEffort: "none" });

  assert.equal(state.config.contextWindow, 1_000_000);
  assert.equal(state.config.maxOutputLabel, "384K");
  assert.equal(state.config.maxOutputSource, "official");
  assert.equal(state.models[0].maxOutputLabel, "384K");
  assert.equal(state.config.reasoningEffort, "high");
  assert.deepEqual(state.models[0].reasoningEfforts, ["none", "low", "high", "max"]);
  assert.equal(disabled.reasoningEffort, "none");
  await assert.rejects(
    () => store.loadConfig({ reasoningEffort: "xhigh" }),
    (error) => error instanceof RuntimeConfigError && error.code === "REASONING_EFFORT_UNSUPPORTED",
  );
});

test("未知模型保留提供方元数据，缺失时才公开兼容档位", () => {
  const models = parseModelCatalog({
    data: [
      { id: "gateway-model", context_window: 32000, reasoning_efforts: ["low", "high"] },
      { id: "plain-chat" },
    ],
  }, "openai-chat-completions");

  assert.equal(models[0].contextWindow, 32000);
  assert.equal(models[0].contextSource, "provider");
  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);
  assert.equal(models[0].reasoningSource, "provider");
  assert.deepEqual(models[0].compatibleReasoningEfforts, []);
  assert.equal(models[1].contextWindow, undefined);
  assert.deepEqual(models[1].reasoningEfforts, []);
  assert.deepEqual(models[1].compatibleReasoningEfforts, ["low", "medium", "high"]);
  assert.notEqual(models[1].reasoningSource, "inferred");
});

function unknownOpenAiStore(protocol = "openai-responses") {
  return new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "gateway-unknown",
      protocol,
      endpoint: protocol === "openai-responses"
        ? "https://provider.example/v1/responses"
        : "https://provider.example/v1/chat/completions",
      reasoningEffort: "high",
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });
}

test("未知 OpenAI 模型默认自动，并公开兼容档位而非模型默认能力", async () => {
  const store = unknownOpenAiStore();
  const state = await store.getPublicState();

  assert.equal(state.config.reasoningEffort, null);
  assert.deepEqual(state.config.reasoningEfforts, []);
  assert.deepEqual(state.config.compatibleReasoningEfforts, ["low", "medium", "high"]);
  assert.equal(state.models[0].defaultReasoningEffort, null);
});

test("未知 OpenAI 模型仅接受兼容集合内的会话级思考选择", async () => {
  const store = unknownOpenAiStore();

  for (const effort of ["low", "high"]) {
    assert.equal((await store.loadConfig({ reasoningEffort: effort })).reasoningEffort, effort);
  }
  for (const effort of ["none", "minimal", "xhigh", "max"]) {
    await assert.rejects(
      () => store.loadConfig({ reasoningEffort: effort }),
      (error) => error instanceof RuntimeConfigError && error.code === "REASONING_EFFORT_UNSUPPORTED",
    );
  }
});

test("Qwen3.7 Max Chat Completions 仅接受官方关闭选择", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "qwen3.7-max",
      protocol: "openai-chat-completions",
      endpoint: "https://provider.example/v1/chat/completions",
      reasoningEffort: "high",
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  const state = await store.getPublicState();
  assert.equal(state.config.thinkingToggle, true);
  assert.equal((await store.loadConfig()).reasoningEffort, null);
  assert.equal((await store.loadConfig({ reasoningEffort: "none" })).reasoningEffort, "none");
  await assert.rejects(
    () => store.loadConfig({ reasoningEffort: "low" }),
    (error) => error instanceof RuntimeConfigError && error.code === "REASONING_EFFORT_UNSUPPORTED",
  );
});

test("Qwen3.7 Max Responses 使用官方等级和中等默认值", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "qwen3.7-max",
      protocol: "openai-responses",
      endpoint: "https://provider.example/v1/responses",
      reasoningEffort: null,
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  assert.equal((await store.loadConfig()).reasoningEffort, "medium");
  for (const effort of ["none", "minimal", "low", "medium", "high"]) {
    assert.equal((await store.loadConfig({ reasoningEffort: effort })).reasoningEffort, effort);
  }
  for (const effort of ["xhigh", "max"]) {
    await assert.rejects(
      () => store.loadConfig({ reasoningEffort: effort }),
      (error) => error instanceof RuntimeConfigError && error.code === "REASONING_EFFORT_UNSUPPORTED",
    );
  }
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

test("系统配置未显式设置上下文时采用官方能力并锁定默认思考等级", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "gpt-5.6-sol",
      reasoningEffort: "none",
      contextWindow: 200000,
      contextWindowConfigured: false,
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  const state = await store.getPublicState();

  assert.equal(state.config.contextWindow, 1_050_000);
  assert.equal(state.config.reasoningEffort, "medium");
  assert.deepEqual(state.models[0].reasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
});

test("系统配置显式设置的上下文优先于官方默认值", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "gpt-5.6-sol",
      contextWindow: 123456,
      contextWindowConfigured: true,
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  assert.equal((await store.getPublicState()).config.contextWindow, 123456);
});

test("历史思考等级不能污染官方模型的受支持等级", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => ({
      ...systemConfig(),
      model: "gpt-5.5",
      reasoningEffort: "max",
      contextWindowConfigured: false,
    }),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore: memorySettingsStore(),
  });

  const state = await store.getPublicState();

  assert.equal(state.config.reasoningEffort, "medium");
  assert.equal(state.models[0].reasoningEfforts.includes("max"), false);
  await assert.rejects(
    () => store.loadConfig({ reasoningEffort: "max" }),
    (error) => error instanceof RuntimeConfigError && error.code === "REASONING_EFFORT_UNSUPPORTED",
  );
});

test("启动连通性探测使用系统模型目录 GET，且不改变配置或目录缓存", async () => {
  const settingsStore = memorySettingsStore({
    version: 1,
    useSystemConfig: true,
    maxSteps: 75,
    approvalMode: "required",
  });
  let request;
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: "gpt-5-system" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    settingsStore,
  });
  const persistedBeforeProbe = settingsStore.value;

  const connectivity = await store.probeCurrentProvider();

  assert.deepEqual(connectivity, { status: "connected" });
  assert.equal(request.url, "https://provider.example/v1/models");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, "Bearer system-secret");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(request.options.cache, "no-store");
  assert.equal(Object.hasOwn(request.options, "body"), false);
  assert.deepEqual(settingsStore.value, persistedBeforeProbe);
  assert.equal(store.catalogs.system, null);
  assert.equal(store.catalogs.custom, null);
  assert.equal(store.lastCustomDiscovery, null);
  assert.equal(JSON.stringify(connectivity).includes("system-secret"), false);
});

test("启动连通性探测使用当前已保存的自定义协议与凭据", async () => {
  const settingsStore = memorySettingsStore({
    version: 1,
    useSystemConfig: false,
    custom: {
      protocol: "anthropic-messages",
      apiUrl: "https://anthropic.example",
      encryptedApiKey: "cipher:custom-secret",
      model: "claude-sonnet",
      contextWindow: 200000,
      catalog: [{ id: "claude-sonnet" }],
    },
  });
  let request;
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    settingsStore,
  });
  await store.ready;
  const persistedBeforeProbe = settingsStore.value;
  const catalogBeforeProbe = structuredClone(store.catalogs.custom);
  const discoveryBeforeProbe = structuredClone(store.lastCustomDiscovery);

  const connectivity = await store.probeCurrentProvider();

  assert.deepEqual(connectivity, { status: "connected" });
  assert.equal(request.url, "https://anthropic.example/v1/models");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers["x-api-key"], "custom-secret");
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(request.options.cache, "no-store");
  assert.equal(Object.hasOwn(request.options, "body"), false);
  assert.deepEqual(settingsStore.value, persistedBeforeProbe);
  assert.deepEqual(store.catalogs.custom, catalogBeforeProbe);
  assert.deepEqual(store.lastCustomDiscovery, discoveryBeforeProbe);
  assert.equal(JSON.stringify(connectivity).includes("custom-secret"), false);
});

test("启动连通性探测以脱敏状态归类提供方失败", async (t) => {
  const scenarios = [
    {
      name: "网络错误",
      fetchImpl: async () => { throw new Error("system-secret unavailable"); },
      expectedCode: "PROVIDER_UNAVAILABLE",
    },
    {
      name: "超时",
      fetchImpl: async () => {
        const error = new Error("system-secret timed out");
        error.name = "AbortError";
        throw error;
      },
      expectedCode: "PROVIDER_TIMEOUT",
    },
    {
      name: "HTTP 错误",
      fetchImpl: async () => new Response("system-secret upstream detail", { status: 401 }),
      expectedCode: "PROVIDER_HTTP_ERROR",
    },
    {
      name: "空模型目录",
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      expectedCode: "PROVIDER_RESPONSE_INVALID",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const store = new RuntimeConfigStore({
        systemLoader: async () => systemConfig(),
        fetchImpl: scenario.fetchImpl,
        settingsStore: memorySettingsStore(),
      });

      const connectivity = await store.probeCurrentProvider();

      assert.deepEqual(connectivity, { status: "failed", code: scenario.expectedCode });
      assert.equal(JSON.stringify(connectivity).includes("system-secret"), false);
    });
  }
});

test("模型发现错误统一脱敏 JSON、Basic、Bearer 和查询认证信息", async () => {
  const secretMarkers = ["system-secret", "json-secret", "basic-secret", "bearer-secret", "query-secret"];
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => new Response([
      '{"api_key":"json-secret","authorization":"Basic basic-secret"}',
      "Authorization: Bearer bearer-secret",
      "https://provider.example/error?token=query-secret",
      "system-secret",
    ].join(" "), { status: 401 }),
    settingsStore: memorySettingsStore(),
  });

  await assert.rejects(
    () => store.discoverModels(),
    (error) => {
      assert.equal(error instanceof RuntimeConfigError, true);
      assert.equal(error.code, "MODELS_HTTP_ERROR");
      for (const marker of secretMarkers) assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
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
  const selected = await store.loadConfig({ model: "gpt-5-backup", reasoningEffort: "high" });

  assert.equal(request.url, "https://custom.example/v1/models");
  assert.equal(request.authorization, "Bearer custom-secret");
  assert.equal(state.source, "custom");
  assert.equal(state.settings.apiUrl, "https://custom.example");
  assert.equal(JSON.stringify(state).includes("custom-secret"), false);
  assert.equal(selected.model, "gpt-5-backup");
  assert.equal(selected.reasoningEffort, "high");
});

test("自定义保存忽略伪造思考等级，临时模型使用自己的上下文", async () => {
  const settingsStore = memorySettingsStore();
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "gpt-5.6-sol" }, { id: "qwen3.7-max" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    settingsStore,
  });

  await store.discoverModels({
    useSystemConfig: false,
    protocol: "openai-chat-completions",
    apiUrl: "https://custom.example/v1",
    apiKey: "custom-secret",
  });
  const state = await store.update({
    useSystemConfig: false,
    protocol: "openai-chat-completions",
    apiUrl: "https://custom.example/v1",
    apiKey: "custom-secret",
    model: "gpt-5.6-sol",
    contextWindow: 123456,
    reasoningEffort: "none",
  });
  const switched = await store.loadConfig({ model: "qwen3.7-max" });

  assert.equal(state.config.reasoningEffort, "medium");
  assert.equal(state.config.contextWindow, 123456);
  assert.equal(settingsStore.value.custom.reasoningEffort, "medium");
  assert.equal(switched.contextWindow, 1_000_000);
  assert.equal(switched.reasoningEffort, null);
});

test("恢复历史 Qwen 配置时将思考等级规范为提供方自动模式", async () => {
  const settingsStore = memorySettingsStore({
    version: 1,
    useSystemConfig: false,
    custom: {
      protocol: "openai-chat-completions",
      apiUrl: "https://custom.example",
      encryptedApiKey: "cipher:custom-secret",
      model: "qwen3.7-max",
      contextWindow: 500000,
      reasoningEffort: "high",
      catalog: [{ id: "qwen3.7-max" }],
    },
  });
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore,
  });

  const state = await store.getPublicState();

  assert.equal(state.source, "custom");
  assert.equal(state.config.reasoningEffort, null);
  assert.equal(state.config.contextWindow, 500000);
  assert.equal(state.settings.contextWindow, 500000);
  assert.equal(state.settings.models[0].reasoningMode, "thinking-toggle");
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

test("拒绝包含换行的自定义 API Key", async () => {
  const store = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    settingsStore: memorySettingsStore(),
  });

  await assert.rejects(
    () => store.update({
      useSystemConfig: false,
      apiUrl: "https://custom.example/v1",
      apiKey: "secret\ninvalid",
      model: "gpt-test",
      contextWindow: 128000,
      reasoningEffort: "low",
    }),
    (error) => error instanceof RuntimeConfigError && error.code === "API_KEY_INVALID",
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

test("审批模式默认需要审批、可持久化并在重启后恢复", async () => {
  const settingsStore = memorySettingsStore();
  const first = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore,
  });

  assert.equal((await first.getPublicState()).settings.approvalMode, "required");
  const state = await first.updateApprovalMode("auto");
  assert.equal(state.settings.approvalMode, "auto");
  assert.equal(settingsStore.value.approvalMode, "auto");

  await first.update({ useSystemConfig: true, maxSteps: 222 });
  assert.equal(settingsStore.value.approvalMode, "auto");

  const restarted = new RuntimeConfigStore({
    systemLoader: async () => systemConfig(),
    fetchImpl: async () => { throw new Error("not used"); },
    settingsStore,
  });
  assert.equal((await restarted.getPublicState()).settings.approvalMode, "auto");
  await assert.rejects(
    () => restarted.updateApprovalMode("ask"),
    (error) => error instanceof RuntimeConfigError && error.code === "APPROVAL_MODE_INVALID",
  );
  assert.equal((await restarted.getPublicState()).settings.approvalMode, "auto");
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

test("系统配置来源可选择 Claude CLI 并持久化", async () => {
  let requestedSource = null;
  const settingsStore = memorySettingsStore();
  const store = new RuntimeConfigStore({
    systemLoader: async ({ source } = {}) => {
      requestedSource = source;
      return {
        ...systemConfig(),
        cliSource: source === "claude" ? "claude" : "codex",
        providerName: source === "claude" ? "Claude CLI" : "Codex CLI",
        protocol: source === "claude" ? "anthropic-messages" : "openai-responses",
        wireApi: source === "claude" ? "messages" : "responses",
        endpoint: source === "claude"
          ? "https://provider.example/v1/messages"
          : "https://provider.example/v1/responses",
        responsesUrl: source === "claude" ? null : "https://provider.example/v1/responses",
      };
    },
    settingsStore,
  });

  const state = await store.update({ useSystemConfig: true, systemSource: "claude", maxSteps: 100 });

  assert.equal(requestedSource, "claude");
  assert.equal(state.config.providerName, "Claude CLI");
  assert.equal(state.settings.systemSource, "claude");
  assert.equal(settingsStore.value.systemSource, "claude");
});
