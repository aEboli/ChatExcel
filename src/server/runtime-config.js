import {
  buildResponsesUrl,
  DEFAULT_CONTEXT_WINDOW,
  loadCodexConfig,
  REASONING_EFFORTS,
  toPublicConfig,
} from "./config.js";
import {
  DEFAULT_PROTOCOL,
  buildProtocolEndpoints,
  getProtocolDefinition,
  normalizeApiRoot,
  protocolAuthHeaders,
  protocolCompatibleReasoningEfforts,
  protocolOptions,
  protocolReasoningEfforts,
} from "./protocols.js";
import { resolveOfficialModelCapabilities } from "./model-capability-catalog.js";
import { DEFAULT_MAX_STEPS, normalizeMaxSteps } from "./limits.js";
import { sanitizeProviderErrorSummary } from "./provider-redaction.js";
import { DEFAULT_APPROVAL_MODE, isApprovalMode, SettingsStore } from "./settings-store.js";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_API_KEY_LENGTH = 8_192;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;
const PROVIDER_CONNECTIVITY_TIMEOUT_MS = 10_000;

export class RuntimeConfigError extends Error {
  constructor(code, message, statusCode = 400, options = {}) {
    super(message, options);
    this.name = "RuntimeConfigError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function validateModelId(value) {
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value.trim())) {
    throw new RuntimeConfigError("MODEL_ID_INVALID", "请选择有效的模型 ID。" );
  }
  return value.trim();
}

function validateApiKey(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_API_KEY_LENGTH || /[\r\n\0]/.test(value)) {
    throw new RuntimeConfigError("API_KEY_INVALID", "请输入有效的 API Key。" );
  }
  return value.trim();
}

function validateContextWindow(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1_024 || parsed > 2_000_000) {
    throw new RuntimeConfigError(
      "CONTEXT_WINDOW_INVALID",
      "上下文长度必须是 1024 到 2000000 之间的整数。",
    );
  }
  return parsed;
}

function validateProtocol(value) {
  const protocol = value === "responses" ? DEFAULT_PROTOCOL : value ?? DEFAULT_PROTOCOL;
  try {
    return getProtocolDefinition(protocol).id;
  } catch (error) {
    throw new RuntimeConfigError("PROTOCOL_UNSUPPORTED", "请选择支持的 API 协议。", 400, {
      cause: error,
    });
  }
}

function validateApprovalMode(value) {
  if (!isApprovalMode(value)) {
    throw new RuntimeConfigError("APPROVAL_MODE_INVALID", "审批模式只能是需要审批或无需审批。" );
  }
  return value;
}

function uniqueEfforts(values) {
  if (!Array.isArray(values)) return [];
  const allowed = new Set(REASONING_EFFORTS);
  return [...new Set(values.filter((value) => typeof value === "string" && allowed.has(value)))];
}

function inferEfforts(protocol, modelId) {
  return protocolReasoningEfforts(protocol, modelId);
}

export function inferReasoningEfforts(modelId, protocol = DEFAULT_PROTOCOL) {
  return inferEfforts(protocol, modelId);
}

function modelReasoningMetadata(model) {
  const preservesPersistedEfforts = model?.reasoningSource !== "inferred"
    && model?.reasoningSource !== "compatibility";
  const candidates = [
    model?.supported_reasoning_efforts,
    model?.reasoning_efforts,
    ...(preservesPersistedEfforts ? [model?.reasoningEfforts] : []),
    model?.supportedReasoningEfforts,
    model?.capabilities?.reasoning_efforts,
    model?.capabilities?.supported_reasoning_efforts,
    model?.metadata?.reasoning_efforts,
  ];
  for (const candidate of candidates) {
    const efforts = uniqueEfforts(candidate);
    if (efforts.length > 0) return efforts;
  }
  return [];
}

function modelContextWindowMetadata(model) {
  const candidates = [model?.inputTokenLimit, model?.context_window, model?.contextWindow];
  return candidates.find((value) => Number.isSafeInteger(value) && value > 0) ?? null;
}

function modelCatalogEntry(protocol, id, model) {
  const official = resolveOfficialModelCapabilities(protocol, id);
  if (official) {
    return {
      id,
      contextWindow: official.contextWindow,
      contextSource: "official",
      reasoningEfforts: official.reasoningEfforts,
      compatibleReasoningEfforts: [],
      reasoningMode: official.reasoningMode,
      reasoningSource: "official",
      defaultReasoningEffort: official.defaultReasoningEffort,
      capabilityReference: official.reference,
      capabilityReferences: official.references,
      ...(official.thinkingToggle === true ? { thinkingToggle: true } : {}),
    };
  }

  const declaredEfforts = modelReasoningMetadata(model);
  const reasoningEfforts = declaredEfforts.length > 0 ? declaredEfforts : inferEfforts(protocol, id);
  const compatibleReasoningEfforts = reasoningEfforts.length === 0
    ? protocolCompatibleReasoningEfforts(protocol)
    : [];
  const contextWindow = modelContextWindowMetadata(model);
  return {
    id,
    reasoningEfforts,
    compatibleReasoningEfforts,
    reasoningMode: "levels",
    reasoningSource: declaredEfforts.length > 0
      ? "provider"
      : compatibleReasoningEfforts.length > 0
        ? "compatibility"
        : "inferred",
    defaultReasoningEffort: reasoningEfforts[0] ?? null,
    ...(contextWindow ? { contextWindow, contextSource: "provider" } : {}),
  };
}

export function parseModelCatalog(payload, protocol = DEFAULT_PROTOCOL) {
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : null;
  if (!entries) {
    throw new RuntimeConfigError(
      "MODELS_RESPONSE_INVALID",
      "模型接口响应缺少 data 或 models 数组。",
      502,
    );
  }

  const normalizedProtocol = validateProtocol(protocol);
  const catalog = new Map();
  for (const entry of entries) {
    const rawId = typeof entry === "string" ? entry : entry?.id ?? entry?.name;
    if (typeof rawId !== "string") continue;
    const id = rawId.trim().replace(/^models\//i, "");
    if (!MODEL_ID_PATTERN.test(id)) continue;
    catalog.set(id, modelCatalogEntry(normalizedProtocol, id, entry));
  }
  if (catalog.size === 0) {
    throw new RuntimeConfigError("MODELS_EMPTY", "模型接口没有返回可用的模型 ID。", 502);
  }
  return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function safeProviderMessage(text, token) {
  return sanitizeProviderErrorSummary(text, { secrets: [token], maxLength: 300 });
}

function buildModelsUrl(baseUrl, protocol) {
  return buildProtocolEndpoints(protocol, baseUrl).modelsUrl;
}

function protocolFromConfig(config) {
  return validateProtocol(config?.protocol ?? config?.wireApi ?? DEFAULT_PROTOCOL);
}

function addCurrentModel(catalog, config) {
  const models = Array.isArray(catalog) ? catalog.map((entry) => ({ ...entry })) : [];
  let current = models.find((entry) => entry.id === config.model);
  if (!current) {
    current = modelCatalogEntry(protocolFromConfig(config), config.model);
    models.unshift(current);
  }
  if (!("defaultReasoningEffort" in current)) {
    current.defaultReasoningEffort = current.reasoningEfforts[0] ?? null;
  }
  return models;
}

function normalizeCustomBaseUrl(apiUrl) {
  try {
    return normalizeApiRoot(apiUrl);
  } catch (error) {
    throw new RuntimeConfigError("API_URL_INVALID", "请输入有效的 HTTP 或 HTTPS API 根地址。", 400, {
      cause: error,
    });
  }
}

function cloneCatalog(catalog) {
  return Array.isArray(catalog) ? catalog.map((entry) => ({ ...entry })) : [];
}

export class RuntimeConfigStore {
  constructor({
    systemLoader = loadCodexConfig,
    fetchImpl = globalThis.fetch,
    discoveryTimeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
    connectivityTimeoutMs = PROVIDER_CONNECTIVITY_TIMEOUT_MS,
    settingsStore = new SettingsStore(),
  } = {}) {
    if (typeof systemLoader !== "function" || typeof fetchImpl !== "function") {
      throw new TypeError("RuntimeConfigStore 需要配置读取器和 fetch 实现。" );
    }
    if (!settingsStore || typeof settingsStore.load !== "function" || typeof settingsStore.save !== "function") {
      throw new TypeError("RuntimeConfigStore 需要配置持久化存储。" );
    }
    this.systemLoader = systemLoader;
    this.fetchImpl = fetchImpl;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.connectivityTimeoutMs = connectivityTimeoutMs;
    this.settingsStore = settingsStore;
    this.mode = "system";
    this.customConfig = null;
    this.catalogs = { system: null, custom: null };
    this.lastCustomDiscovery = null;
    this.settingsError = null;
    this.maxSteps = DEFAULT_MAX_STEPS;
    this.approvalMode = DEFAULT_APPROVAL_MODE;
    this.ready = this.#restoreSettings();
  }

  async #restoreSettings() {
    let persisted;
    try {
      persisted = await this.settingsStore.load();
    } catch (error) {
      this.settingsError = error;
      return;
    }
    try {
      this.maxSteps = normalizeMaxSteps(persisted?.maxSteps ?? DEFAULT_MAX_STEPS, {
        ErrorClass: RuntimeConfigError,
      });
    } catch (error) {
      this.settingsError = error;
      this.maxSteps = DEFAULT_MAX_STEPS;
    }
    try {
      this.approvalMode = validateApprovalMode(persisted?.approvalMode ?? DEFAULT_APPROVAL_MODE);
    } catch (error) {
      this.settingsError ??= error;
      this.approvalMode = DEFAULT_APPROVAL_MODE;
    }
    const custom = persisted?.custom;
    if (!custom || typeof custom !== "object") return;
    let protocol;
    try {
      protocol = validateProtocol(custom.protocol);
      const baseUrl = normalizeCustomBaseUrl(custom.apiUrl);
      const model = validateModelId(custom.model);
      const contextWindow = validateContextWindow(custom.contextWindow);
      const token = await this.settingsStore.decryptCustom(custom);
      if (!token) return;
      const rawCatalog = Array.isArray(custom.catalog) ? custom.catalog : [];
      const catalog = rawCatalog.length > 0
        ? parseModelCatalog({ models: rawCatalog }, protocol)
        : [];
      const entry = catalog.find((item) => item.id === model) ?? modelCatalogEntry(protocol, model);
      const reasoningEffort = entry.defaultReasoningEffort ?? null;
      this.customConfig = this.#makeCustomConfig({
        protocol,
        baseUrl,
        token,
        model,
        contextWindow,
        reasoningEffort,
      });
      this.catalogs.custom = catalog;
      this.lastCustomDiscovery = { protocol, baseUrl, models: cloneCatalog(catalog) };
      if (persisted.useSystemConfig === false) this.mode = "custom";
    } catch (error) {
      this.settingsError = error;
    }
  }

  #makeCustomConfig({ protocol, baseUrl, token, model, contextWindow, reasoningEffort }) {
    const endpoints = buildProtocolEndpoints(protocol, baseUrl, model);
    return Object.freeze({
      configPath: null,
      providerId: "runtime-custom",
      providerName: getProtocolDefinition(protocol).label,
      model,
      baseUrl,
      endpoint: endpoints.endpoint,
      responsesUrl: protocol === DEFAULT_PROTOCOL ? endpoints.endpoint : null,
      protocol,
      wireApi: protocol === DEFAULT_PROTOCOL ? "responses" : protocol,
      reasoningEffort,
      verbosity: null,
      contextWindow,
      contextWindowConfigured: true,
      token,
      tokenSource: "encrypted-settings",
    });
  }

  async #persistState() {
    const custom = this.customConfig
      ? {
          protocol: this.customConfig.protocol,
          apiUrl: this.customConfig.baseUrl,
          apiKey: this.customConfig.token,
          model: this.customConfig.model,
          contextWindow: this.customConfig.contextWindow,
          reasoningEffort: this.customConfig.reasoningEffort,
          catalog: cloneCatalog(this.catalogs.custom),
        }
      : null;
    await this.settingsStore.save({
      useSystemConfig: this.mode === "system",
      maxSteps: this.maxSteps,
      approvalMode: this.approvalMode,
      custom,
    });
  }

  async loadConfig(options = {}) {
    await this.ready;
    const baseConfig = this.mode === "system" ? await this.systemLoader() : this.customConfig;
    if (!baseConfig) {
      throw new RuntimeConfigError("CUSTOM_CONFIG_MISSING", "自定义配置尚未保存。", 503);
    }
    const normalizedConfig = {
      ...baseConfig,
      protocol: protocolFromConfig(baseConfig),
      endpoint: baseConfig.endpoint ?? baseConfig.responsesUrl,
    };
    const catalog = addCurrentModel(this.catalogs[this.mode], normalizedConfig);
    const model = options.model === undefined ? normalizedConfig.model : validateModelId(options.model);
    const modelEntry = catalog.find((entry) => entry.id === model);
    if (!modelEntry) {
      throw new RuntimeConfigError("MODEL_NOT_AVAILABLE", "所选模型不在当前可用模型列表中。" );
    }
    const isCurrentModel = model === normalizedConfig.model;
    const reasoningEffort = options.reasoningEffort === undefined
      ? modelEntry.defaultReasoningEffort ?? null
      : options.reasoningEffort;
    const compatibleReasoningEfforts = Array.isArray(modelEntry.compatibleReasoningEfforts)
      ? modelEntry.compatibleReasoningEfforts
      : [];
    const supportedReasoningEfforts = modelEntry.reasoningEfforts.length > 0
      ? modelEntry.reasoningEfforts
      : compatibleReasoningEfforts;
    if (
      reasoningEffort !== null &&
      (typeof reasoningEffort !== "string" || !supportedReasoningEfforts.includes(reasoningEffort))
    ) {
      throw new RuntimeConfigError(
        "REASONING_EFFORT_UNSUPPORTED",
        "所选模型不支持当前思考等级。",
      );
    }
    return Object.freeze({
      ...normalizedConfig,
      model,
      reasoningEffort,
      contextWindow: isCurrentModel && (
        modelEntry.contextSource !== "official" || normalizedConfig.contextWindowConfigured === true
      )
        ? normalizedConfig.contextWindow ?? modelEntry.contextWindow ?? DEFAULT_CONTEXT_WINDOW
        : modelEntry.contextWindow ?? normalizedConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    });
  }

  async getPublicState() {
    await this.ready;
    const config = await this.loadConfig();
    const models = addCurrentModel(this.catalogs[this.mode], config);
    const currentModel = models.find((entry) => entry.id === config.model);
    const custom = this.customConfig;
    return {
      source: this.mode,
      config: {
        ...toPublicConfig(config),
        protocol: config.protocol,
        protocolLabel: getProtocolDefinition(config.protocol).label,
        reasoningEfforts: currentModel.reasoningEfforts,
        compatibleReasoningEfforts: currentModel.compatibleReasoningEfforts,
        reasoningMode: currentModel.reasoningMode,
        reasoningSource: currentModel.reasoningSource,
        defaultReasoningEffort: currentModel.defaultReasoningEffort,
        thinkingToggle: currentModel.thinkingToggle === true,
        contextSource: currentModel.contextSource ?? null,
      },
      models,
      protocols: protocolOptions(),
      settings: {
        useSystemConfig: this.mode === "system",
        protocol: custom?.protocol ?? DEFAULT_PROTOCOL,
        apiUrl: custom?.baseUrl ?? "",
        model: custom?.model ?? config.model,
        contextWindow: custom?.contextWindow ?? config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        reasoningEffort: custom?.reasoningEffort ?? null,
        maxSteps: this.maxSteps,
        approvalMode: this.approvalMode,
        credentialConfigured: Boolean(custom?.token),
        models: cloneCatalog(this.catalogs.custom),
      },
    };
  }

  async update(settings) {
    await this.ready;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new RuntimeConfigError("SETTINGS_INVALID", "配置请求格式无效。" );
    }
    let maxSteps;
    try {
      maxSteps = normalizeMaxSteps(settings.maxSteps ?? this.maxSteps, {
        ErrorClass: RuntimeConfigError,
      });
    } catch (error) {
      if (error instanceof RuntimeConfigError) {
        error.message = "最大步骤数必须是 1 到 1000 之间的整数。";
        throw error;
      }
      throw new RuntimeConfigError("MAX_STEPS_INVALID", "最大步骤数配置无效。");
    }
    if (settings.useSystemConfig === true) {
      this.maxSteps = maxSteps;
      this.mode = "system";
      await this.#persistState();
      return this.getPublicState();
    }
    if (settings.useSystemConfig !== false) {
      throw new RuntimeConfigError("SETTINGS_INVALID", "请选择是否使用系统 Codex 配置。" );
    }

    const protocol = validateProtocol(settings.protocol);
    const baseUrl = normalizeCustomBaseUrl(settings.apiUrl);
    const existingToken = this.customConfig?.protocol === protocol && this.customConfig?.baseUrl === baseUrl
      ? this.customConfig.token
      : null;
    const token = settings.apiKey === "" || settings.apiKey === undefined
      ? existingToken
      : validateApiKey(settings.apiKey);
    if (!token) {
      throw new RuntimeConfigError("API_KEY_REQUIRED", "首次保存自定义配置时必须填写 API Key。" );
    }
    const model = validateModelId(settings.model);
    const discovery = this.lastCustomDiscovery;
    if (!discovery || discovery.protocol !== protocol || discovery.baseUrl !== baseUrl) {
      throw new RuntimeConfigError("MODELS_NOT_DISCOVERED", "请先获取当前协议和 API URL 的模型列表。" );
    }
    const modelEntry = discovery.models.find((entry) => entry.id === model);
    if (!modelEntry) {
      throw new RuntimeConfigError("MODEL_NOT_AVAILABLE", "请选择获取到的模型 ID。" );
    }
    const reasoningEffort = modelEntry.defaultReasoningEffort ?? null;
    const contextWindow = validateContextWindow(settings.contextWindow);
    this.customConfig = this.#makeCustomConfig({
      protocol,
      baseUrl,
      token,
      model,
      contextWindow,
      reasoningEffort,
    });
    this.maxSteps = maxSteps;
    this.catalogs.custom = cloneCatalog(discovery.models);
    this.mode = "custom";
    await this.#persistState();
    return this.getPublicState();
  }

  async updateApprovalMode(approvalMode) {
    await this.ready;
    const nextMode = validateApprovalMode(approvalMode);
    const previousMode = this.approvalMode;
    this.approvalMode = nextMode;
    try {
      await this.#persistState();
    } catch (error) {
      this.approvalMode = previousMode;
      throw error;
    }
    return this.getPublicState();
  }

  getMaxSteps() {
    return this.maxSteps;
  }

  async probeCurrentProvider() {
    await this.ready;
    try {
      const config = await this.loadConfig();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.connectivityTimeoutMs);
      timeout.unref?.();
      let response;
      try {
        response = await this.fetchImpl(buildModelsUrl(config.baseUrl, config.protocol), {
          method: "GET",
          headers: {
            ...protocolAuthHeaders(config.protocol, config.token),
            Accept: "application/json",
          },
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (error) {
        return {
          status: "failed",
          code: error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        };
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) return { status: "failed", code: "PROVIDER_HTTP_ERROR" };
      try {
        parseModelCatalog(await response.json(), config.protocol);
      } catch {
        return { status: "failed", code: "PROVIDER_RESPONSE_INVALID" };
      }
      return { status: "connected" };
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : "PROVIDER_UNAVAILABLE";
      return { status: "failed", code };
    }
  }

  async discoverModels(settings = {}) {
    await this.ready;
    const useSystemConfig = settings.useSystemConfig !== false;
    let config;
    let baseUrl;
    let token;
    let protocol;
    let source;
    if (useSystemConfig) {
      config = await this.systemLoader();
      protocol = protocolFromConfig(config);
      baseUrl = config.baseUrl;
      token = config.token;
      source = "system";
    } else {
      protocol = validateProtocol(settings.protocol);
      baseUrl = normalizeCustomBaseUrl(settings.apiUrl);
      const existingToken = this.customConfig?.protocol === protocol && this.customConfig?.baseUrl === baseUrl
        ? this.customConfig.token
        : null;
      token = settings.apiKey === "" || settings.apiKey === undefined
        ? existingToken
        : validateApiKey(settings.apiKey);
      if (!token) {
        throw new RuntimeConfigError("API_KEY_REQUIRED", "获取模型前请填写 API Key。" );
      }
      source = "custom";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.discoveryTimeoutMs);
    timeout.unref?.();
    let response;
    try {
      response = await this.fetchImpl(buildModelsUrl(baseUrl, protocol), {
        headers: {
          ...protocolAuthHeaders(protocol, token),
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new RuntimeConfigError(
        error?.name === "AbortError" ? "MODELS_TIMEOUT" : "MODELS_UNAVAILABLE",
        error?.name === "AbortError" ? "获取模型超时。" : "无法连接模型接口。",
        502,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const summary = safeProviderMessage(await response.text(), token);
      throw new RuntimeConfigError(
        "MODELS_HTTP_ERROR",
        summary
          ? `模型接口返回 HTTP ${response.status}：${summary}`
          : `模型接口返回 HTTP ${response.status}。`,
        502,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new RuntimeConfigError("MODELS_RESPONSE_INVALID", "模型接口返回了无效 JSON。", 502, {
        cause: error,
      });
    }
    const models = parseModelCatalog(payload, protocol);
    this.catalogs[source] = models;
    if (source === "custom") {
      this.lastCustomDiscovery = { protocol, baseUrl, models: cloneCatalog(models) };
      if (this.customConfig && this.customConfig.protocol === protocol && this.customConfig.baseUrl === baseUrl) {
        this.catalogs.custom = cloneCatalog(models);
        await this.#persistState();
      }
    }
    return { source, protocol, models };
  }
}
