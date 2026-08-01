import { loadCodexConfig } from "./config.js";
import {
  clampReasoningEffort,
  getProtocolDefinition,
  parseDataUrl,
  protocolAuthHeaders,
} from "./protocols.js";
import { getResponsesToolDefinitions } from "../shared/excel-tools.js";

export const AGENT_INSTRUCTIONS = `你是当前 Microsoft Excel 工作簿内的操作 Agent。
仅通过已提供的 Excel 工具读取或修改工作簿；工具没有返回成功时，不得声称操作已经完成。
先读取必要的工作簿上下文，再进行精确、最小范围的操作。值、公式、格式、表格、图表、排序和工作表变更都必须使用对应工具。
任务窗格会按照用户当前选择的审批模式处理修改工具；不得规避、合并隐藏或诱导改变该模式。
公式使用 Excel A1 引用和标准函数名。遇到范围、工作表或参数不明确时，先使用读取工具确认。
最终用简体中文简洁说明实际完成结果；如果用户拒绝或工具失败，如实说明。`;

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8_192;

export class ProviderError extends Error {
  constructor(code, message, { statusCode = 502, providerStatus = null, requestId = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.statusCode = statusCode;
    this.providerStatus = providerStatus;
    this.requestId = requestId;
    this.expose = true;
  }
}

function sanitizeSummary(text, token) {
  let summary = typeof text === "string" ? text : "";
  if (token) summary = summary.split(token).join("[REDACTED]");
  return summary
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;"}]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/bearer\s+[^\s,;"}]+/gi, "Bearer [REDACTED]")
    .replace(/x-api-key\s*[:=]\s*[^\s,;}]+/gi, "x-api-key: [REDACTED]")
    .replace(/x-goog-api-key\s*[:=]\s*[^\s,;}]+/gi, "x-goog-api-key: [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function combineAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
  }, timeoutMs);
  timeout.unref?.();

  const abortFromExternal = () => controller.abort(externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function resolveProtocol(config) {
  const protocol = config?.protocol
    ?? (config?.wireApi === "responses" || config?.responsesUrl ? "openai-responses" : null);
  try {
    return getProtocolDefinition(protocol).id;
  } catch (error) {
    throw new ProviderError("PROTOCOL_UNSUPPORTED", "当前配置的 API 协议不受支持。", { statusCode: 500 });
  }
}

function contentParts(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return Array.isArray(content) ? content : [];
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseToolOutput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return { output: parsed };
    } catch {
      return { output: value };
    }
  }
  return { output: value ?? null };
}

function textFromOutputItem(item) {
  if (item?.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function normalizedMessage(role, text) {
  if (typeof text !== "string" || text === "") return null;
  return {
    type: "message",
    role,
    content: [{ type: "output_text", text }],
  };
}

function imageUrlForChat(dataUrl) {
  return { type: "image_url", image_url: { url: dataUrl } };
}

function toChatMessages(input) {
  const messages = [{ role: "system", content: AGENT_INSTRUCTIONS }];
  for (const item of input) {
    if (item?.role === "user") {
      const parts = contentParts(item.content).map((part) => {
        if (part?.type === "input_image" && typeof part.image_url === "string") {
          return imageUrlForChat(part.image_url);
        }
        return { type: "text", text: typeof part?.text === "string" ? part.text : "" };
      }).filter((part) => part.type !== "text" || part.text !== "");
      messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
      continue;
    }
    if (item?.type === "message") {
      const text = textFromOutputItem(item);
      if (text) messages.push({ role: "assistant", content: text });
      continue;
    }
    if (item?.type === "function_call") {
      const previous = messages.at(-1)?.role === "assistant" && messages.at(-1);
      const toolCall = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" },
      };
      if (previous) previous.tool_calls = [...(previous.tool_calls ?? []), toolCall];
      else messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      continue;
    }
    if (item?.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output ?? "") });
    }
  }
  return messages;
}

function chatTools(toolDefinitions) {
  return toolDefinitions.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict === true,
    },
  }));
}

function normalizeChatResponse(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Chat Completions 响应缺少 message。", { statusCode: 502 });
  }
  const output = [];
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n")
      : "";
  const messageItem = normalizedMessage("assistant", text);
  if (messageItem) output.push(messageItem);
  for (const call of message.tool_calls ?? []) {
    if (call?.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string") continue;
    output.push({
      type: "function_call",
      name: call.function.name,
      call_id: call.id,
      arguments: typeof call.function.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function.arguments ?? {}),
    });
  }
  if (output.length === 0) output.push(normalizedMessage("assistant", "") ?? {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "" }],
  });
  return { output, usage: normalizeUsage(payload?.usage) };
}

function toAnthropicMessages(input) {
  const messages = [];
  let assistantBlocks = [];
  let toolBlocks = [];
  const flushAssistant = () => {
    if (assistantBlocks.length > 0) {
      messages.push({ role: "assistant", content: assistantBlocks });
      assistantBlocks = [];
    }
  };
  const flushTools = () => {
    if (toolBlocks.length > 0) {
      messages.push({ role: "user", content: toolBlocks });
      toolBlocks = [];
    }
  };
  for (const item of input) {
    if (item?.role === "user") {
      flushAssistant();
      flushTools();
      const blocks = contentParts(item.content).map((part) => {
        if (part?.type === "input_image" && typeof part.image_url === "string") {
          const parsed = parseDataUrl(part.image_url);
          return { type: "image", source: { type: "base64", media_type: parsed.mimeType, data: parsed.data } };
        }
        return { type: "text", text: typeof part?.text === "string" ? part.text : "" };
      }).filter((part) => part.type !== "text" || part.text !== "");
      messages.push({ role: "user", content: blocks });
      continue;
    }
    if (item?.type === "message") {
      flushTools();
      const text = textFromOutputItem(item);
      if (text) assistantBlocks.push({ type: "text", text });
      continue;
    }
    if (item?.type === "reasoning") {
      flushTools();
      if (typeof item.thinking === "string" && item.thinking !== "") {
        assistantBlocks.push({ type: "thinking", thinking: item.thinking, ...(item.signature ? { signature: item.signature } : {}) });
      }
      continue;
    }
    if (item?.type === "function_call") {
      flushTools();
      assistantBlocks.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseArguments(item.arguments),
      });
      continue;
    }
    if (item?.type === "function_call_output") {
      flushAssistant();
      toolBlocks.push({ type: "tool_result", tool_use_id: item.call_id, content: String(item.output ?? "") });
    }
  }
  flushAssistant();
  flushTools();
  return messages;
}

function anthropicTools(toolDefinitions) {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function normalizeAnthropicResponse(payload) {
  const output = [];
  for (const block of payload?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      output.push(normalizedMessage("assistant", block.text));
    } else if (block?.type === "thinking" && typeof block.thinking === "string") {
      output.push({ type: "reasoning", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) });
    } else if (block?.type === "tool_use" && typeof block.name === "string") {
      output.push({
        type: "function_call",
        name: block.name,
        call_id: typeof block.id === "string" && block.id !== "" ? block.id : `anthropic-call-${output.length + 1}`,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const compact = output.filter(Boolean);
  if (compact.length === 0) compact.push(normalizedMessage("assistant", "") ?? {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "" }],
  });
  return { output: compact, usage: normalizeUsage(payload?.usage) };
}

function toGeminiParts(input, callNames = new Map()) {
  const parts = [];
  for (const item of input) {
    if (item?.role === "user") {
      for (const part of contentParts(item.content)) {
        if (part?.type === "input_image" && typeof part.image_url === "string") {
          const parsed = parseDataUrl(part.image_url);
          parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
        } else if (typeof part?.text === "string" && part.text !== "") {
          parts.push({ text: part.text });
        }
      }
    } else if (item?.type === "message") {
      const text = textFromOutputItem(item);
      if (text) parts.push({ text: text });
    } else if (item?.type === "function_call") {
      callNames.set(item.call_id, item.name);
      parts.push({ functionCall: { name: item.name, args: parseArguments(item.arguments), ...(item.call_id ? { id: item.call_id } : {}) } });
    } else if (item?.type === "function_call_output") {
      const response = parseToolOutput(item.output);
      parts.push({ functionResponse: { name: callNames.get(item.call_id) ?? "excel_tool", response, ...(item.call_id ? { id: item.call_id } : {}) } });
    }
  }
  return parts;
}

function toGeminiContents(input) {
  const contents = [];
  const callNames = new Map();
  let current = null;
  const pushParts = (role, parts) => {
    if (parts.length === 0) return;
    if (current?.role === role) current.parts.push(...parts);
    else {
      current = { role, parts: [...parts] };
      contents.push(current);
    }
  };
  for (const item of input) {
    if (item?.role === "user") pushParts("user", toGeminiParts([item], callNames));
    else if (item?.type === "function_call_output") pushParts("user", toGeminiParts([item], callNames));
    else if (item?.type === "message" || item?.type === "function_call") pushParts("model", toGeminiParts([item], callNames));
  }
  return contents;
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const result = {};
  const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = rawTypes.find((entry) => entry !== "null");
  const typeMap = {
    object: "OBJECT",
    array: "ARRAY",
    string: "STRING",
    number: "NUMBER",
    integer: "INTEGER",
    boolean: "BOOLEAN",
  };
  if (typeMap[type]) result.type = typeMap[type];
  if (rawTypes.includes("null")) result.nullable = true;
  if (typeof schema.description === "string") result.description = schema.description;
  if (schema.properties && typeof schema.properties === "object") {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
  }
  if (schema.items) result.items = toGeminiSchema(schema.items);
  if (Array.isArray(schema.required)) result.required = [...schema.required];
  if (Array.isArray(schema.enum)) {
    result.enum = schema.enum.filter((value) => value !== null).map(String);
  }
  for (const key of ["format", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (schema[key] !== undefined) result[key] = schema[key];
  }
  return result;
}

function geminiTools(toolDefinitions) {
  return [{ functionDeclarations: toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
  })) }];
}

function normalizeGeminiResponse(payload) {
  const output = [];
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (typeof part?.text === "string" && part.text !== "") {
      if (part.thought === true) output.push({ type: "reasoning", thinking: part.text });
      else output.push(normalizedMessage("assistant", part.text));
    }
    if (part?.functionCall && typeof part.functionCall.name === "string") {
      const callId = part.functionCall.id ?? `gemini-call-${output.length + 1}`;
      output.push({
        type: "function_call",
        name: part.functionCall.name,
        call_id: callId,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }
  const compact = output.filter(Boolean);
  if (compact.length === 0) compact.push(normalizedMessage("assistant", "") ?? {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "" }],
  });
  const usageMetadata = payload?.usageMetadata;
  return {
    output: compact,
    usage: normalizeUsage({
      promptTokenCount: usageMetadata?.promptTokenCount,
      candidatesTokenCount: usageMetadata?.candidatesTokenCount,
      totalTokenCount: usageMetadata?.totalTokenCount,
    }),
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const total = Number.isSafeInteger(usage.total_tokens)
    ? usage.total_tokens
    : Number.isSafeInteger(usage.totalTokenCount)
      ? usage.totalTokenCount
      : Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)
        ? usage.prompt_tokens + usage.completion_tokens
        : Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
          ? usage.input_tokens + usage.output_tokens
        : Number.isSafeInteger(usage.promptTokenCount) && Number.isSafeInteger(usage.candidatesTokenCount)
          ? usage.promptTokenCount + usage.candidatesTokenCount
          : null;
  if (total === null) return undefined;
  return {
    total_tokens: total,
    ...(Number.isSafeInteger(usage.input_tokens) ? { input_tokens: usage.input_tokens } : Number.isSafeInteger(usage.prompt_tokens) ? { input_tokens: usage.prompt_tokens } : Number.isSafeInteger(usage.promptTokenCount) ? { input_tokens: usage.promptTokenCount } : {}),
    ...(Number.isSafeInteger(usage.output_tokens) ? { output_tokens: usage.output_tokens } : Number.isSafeInteger(usage.completion_tokens) ? { output_tokens: usage.completion_tokens } : Number.isSafeInteger(usage.candidatesTokenCount) ? { output_tokens: usage.candidatesTokenCount } : {}),
  };
}

function buildAnthropicThinking(config, maxTokens) {
  const effort = clampReasoningEffort("anthropic-messages", config.reasoningEffort);
  if (!effort) return null;
  const budgets = { minimal: 512, low: 1_024, medium: 2_048, high: 4_096 };
  const budget = Math.min(budgets[effort] ?? budgets.high, maxTokens - 1);
  return budget >= 1_024 ? { type: "enabled", budget_tokens: budget } : null;
}

function buildGeminiThinking(config) {
  const effort = clampReasoningEffort("google-gemini", config.reasoningEffort);
  if (!effort) return null;
  const budgets = { minimal: 512, low: 1_024, medium: 2_048, high: 4_096 };
  return { thinkingBudget: budgets[effort] ?? budgets.high };
}

function runtimeMetadata(config) {
  return {
    model: config.model,
    reasoningEffort: config.reasoningEffort ?? null,
    contextWindow: config.contextWindow ?? null,
  };
}

function requestBodyFor(protocol, config, input, toolDefinitions) {
  if (protocol === "openai-responses") {
    const body = {
      model: config.model,
      instructions: AGENT_INSTRUCTIONS,
      input,
      tools: toolDefinitions,
      include: ["reasoning.encrypted_content"],
      store: false,
      parallel_tool_calls: false,
    };
    if (config.reasoningEffort && config.reasoningEffort !== "none") {
      body.reasoning = { effort: config.reasoningEffort, summary: "auto" };
    }
    if (config.verbosity) body.text = { verbosity: config.verbosity };
    return body;
  }
  if (protocol === "openai-chat-completions") {
    const body = {
      model: config.model,
      messages: toChatMessages(input),
      tools: chatTools(toolDefinitions),
      parallel_tool_calls: false,
    };
    if (config.reasoningEffort && config.reasoningEffort !== "none") body.reasoning_effort = config.reasoningEffort;
    return body;
  }
  if (protocol === "anthropic-messages") {
    const body = {
      model: config.model,
      system: AGENT_INSTRUCTIONS,
      messages: toAnthropicMessages(input),
      tools: anthropicTools(toolDefinitions),
      max_tokens: Math.min(DEFAULT_ANTHROPIC_MAX_TOKENS, Math.max(1_024, Math.floor((config.contextWindow ?? 32_000) / 4))),
    };
    const thinking = buildAnthropicThinking(config, body.max_tokens);
    if (thinking) body.thinking = thinking;
    return body;
  }
  const body = {
    systemInstruction: { parts: [{ text: AGENT_INSTRUCTIONS }] },
    contents: toGeminiContents(input),
    tools: geminiTools(toolDefinitions),
  };
  const thinkingConfig = buildGeminiThinking(config);
  if (thinkingConfig) body.generationConfig = { thinkingConfig };
  return body;
}

function normalizeProviderResponse(protocol, payload) {
  if (protocol === "openai-responses") {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.output)) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "模型提供方响应缺少 output 数组。", { statusCode: 502 });
    }
    return { output: payload.output, usage: normalizeUsage(payload.usage), output_text: payload.output_text };
  }
  if (protocol === "openai-chat-completions") return normalizeChatResponse(payload);
  if (protocol === "anthropic-messages") return normalizeAnthropicResponse(payload);
  return normalizeGeminiResponse(payload);
}

export function createProviderClient({
  configLoader = loadCodexConfig,
  fetchImpl = globalThis.fetch,
  timeoutMs = 300_000,
  toolDefinitions = getResponsesToolDefinitions(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数。" );
  return {
    async create({ input, signal, options } = {}) {
      if (!Array.isArray(input)) throw new TypeError("Provider input 必须是数组。" );
      const config = await configLoader(options);
      const protocol = resolveProtocol(config);
      const endpoint = config.endpoint ?? config.responsesUrl;
      if (typeof endpoint !== "string" || endpoint === "") {
        throw new ProviderError("PROVIDER_ENDPOINT_MISSING", "当前协议缺少生成接口地址。", { statusCode: 500 });
      }
      const abort = combineAbortSignal(signal, timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            ...protocolAuthHeaders(protocol, config.token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBodyFor(protocol, config, input, toolDefinitions)),
          signal: abort.signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new ProviderError("AGENT_CANCELLED", "当前 Agent 请求已停止。", { statusCode: 499 });
        }
        if (abort.didTimeOut()) {
          throw new ProviderError("PROVIDER_TIMEOUT", "模型提供方响应超时。", { statusCode: 504 });
        }
        throw new ProviderError("PROVIDER_UNAVAILABLE", "无法连接当前模型提供方。", { statusCode: 502 });
      } finally {
        abort.cleanup();
      }

      const requestId = response.headers.get("x-request-id");
      if (!response.ok) {
        const summary = sanitizeSummary(await response.text(), config.token);
        throw new ProviderError(
          "PROVIDER_HTTP_ERROR",
          summary ? `模型提供方返回 HTTP ${response.status}：${summary}` : `模型提供方返回 HTTP ${response.status}。`,
          { statusCode: 502, providerStatus: response.status, requestId },
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new ProviderError("PROVIDER_RESPONSE_INVALID", "模型提供方返回了无效 JSON。", { statusCode: 502, requestId });
      }
      let normalized;
      try {
        normalized = normalizeProviderResponse(protocol, payload);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("PROVIDER_RESPONSE_INVALID", "模型提供方响应格式无效。", { statusCode: 502, requestId });
      }
      return {
        ...payload,
        ...normalized,
        __chatExcel: runtimeMetadata(config),
      };
    },
  };
}

export const createResponsesClient = createProviderClient;
