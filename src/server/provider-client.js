import { loadCodexConfig } from "./config.js";
import {
  clampReasoningEffort,
  getProtocolDefinition,
  parseDataUrl,
  protocolAuthHeaders,
} from "./protocols.js";
import { resolveOfficialModelCapabilities } from "./model-capability-catalog.js";
import { sanitizeProviderErrorSummary } from "./provider-redaction.js";
import { readProviderResponse, streamingEndpoint } from "./provider-stream.js";
import { getResponsesToolDefinitions } from "../shared/excel-tools.js";

export const AGENT_INSTRUCTIONS = `你是当前 Microsoft Excel 工作簿内的操作 Agent。
仅通过已提供的 Excel 工具读取或修改工作簿；工具没有返回成功时，不得声称操作已经完成。
先读取必要的工作簿上下文，再进行精确、最小范围的操作。值、公式、格式、表格、图表、排序和工作表变更都必须使用对应工具。
对于可计算的派生结果，优先写入 Excel 公式而非静态值；不要覆盖用户未指定的内容或范围。
任务窗格会按照用户当前选择的审批模式处理修改工具；不得规避、合并隐藏或诱导改变该模式。
公式使用 Excel A1 引用和标准函数名。遇到范围、工作表或参数不明确时，先使用读取工具确认。
工具返回失败时，先根据错误代码和参数路径自行修正；范围过大时缩小或分块继续。用户明确拒绝或停止时不得换一种调用方式绕过。
每次修改后检查工具结果中的 impact 和 verification；存在公式错误时先修复，无法修复或验证失败时必须如实说明，不能声称任务已完成。
最终用简体中文简洁说明实际完成结果；如果用户拒绝或工具失败，如实说明。`;

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8_192;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

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
  return sanitizeProviderErrorSummary(text, { secrets: [token] });
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

function interruptionError(externalSignal, abort) {
  if (externalSignal?.aborted) {
    return new ProviderError("AGENT_CANCELLED", "当前 Agent 请求已停止。", { statusCode: 499 });
  }
  if (abort.didTimeOut()) {
    return new ProviderError("PROVIDER_TIMEOUT", "模型提供方响应超时。", { statusCode: 504 });
  }
  return null;
}

function isRetryableTransportError(error) {
  if (error?.code === "PROVIDER_STREAM_DISCONNECTED") return true;
  const code = error?.cause?.code ?? error?.code;
  if (RETRYABLE_TRANSPORT_CODES.has(code)) return true;
  if (error?.name !== "TypeError") return false;
  return /^(fetch failed|failed to fetch|network error)$/i.test(String(error.message).trim());
}

function validateProviderToken(token) {
  if (typeof token !== "string" || token === "" || /[\r\n\0]/.test(token)) {
    throw new ProviderError("PROVIDER_AUTH_INVALID", "当前模型提供方令牌格式无效。", { statusCode: 400 });
  }
  return token;
}

function waitForReconnect(delayMs, signal) {
  if (delayMs === 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout;
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timeout = setTimeout(finish, delayMs);
    timeout.unref?.();
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidProviderResponse(message) {
  return new ProviderError("PROVIDER_RESPONSE_INVALID", message, { statusCode: 502 });
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
      if (item.redacted === true && typeof item.data === "string" && item.data !== "") {
        assistantBlocks.push({ type: "redacted_thinking", data: item.data });
      } else if (typeof item.thinking === "string") {
        const signature = typeof item.signature === "string" ? item.signature : null;
        if (item.thinking !== "" || signature !== null) {
          assistantBlocks.push({
            type: "thinking",
            thinking: item.thinking,
            ...(signature !== null ? { signature } : {}),
          });
        }
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
  if (
    !isRecord(payload) ||
    payload.type !== "message" ||
    payload.role !== "assistant" ||
    !Array.isArray(payload.content) ||
    payload.content.length === 0
  ) {
    throw invalidProviderResponse("Anthropic 响应缺少完成消息内容。");
  }
  const output = [];
  for (const block of payload.content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw invalidProviderResponse("Anthropic 响应包含无效内容块。");
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw invalidProviderResponse("Anthropic 文本内容块无效。");
      }
      const message = normalizedMessage("assistant", block.text);
      if (message) output.push(message);
    } else if (block.type === "thinking") {
      if (typeof block.thinking !== "string" || (hasOwn(block, "signature") && typeof block.signature !== "string")) {
        throw invalidProviderResponse("Anthropic thinking 内容块无效。");
      }
      if (block.thinking !== "" || hasOwn(block, "signature")) {
        output.push({
          type: "reasoning",
          thinking: block.thinking,
          ...(hasOwn(block, "signature") ? { signature: block.signature } : {}),
        });
      }
    } else if (block.type === "redacted_thinking") {
      if (typeof block.data !== "string" || block.data === "") {
        throw invalidProviderResponse("Anthropic redacted thinking 内容块无效。");
      }
      output.push({ type: "reasoning", redacted: true, data: block.data });
    } else if (block.type === "tool_use") {
      if (
        typeof block.id !== "string" ||
        block.id === "" ||
        typeof block.name !== "string" ||
        block.name === "" ||
        !isRecord(block.input)
      ) {
        throw invalidProviderResponse("Anthropic 工具调用内容块无效。");
      }
      output.push({
        type: "function_call",
        name: block.name,
        call_id: block.id,
        arguments: JSON.stringify(block.input),
      });
    } else {
      throw invalidProviderResponse("Anthropic 响应包含不受支持的内容块。");
    }
  }
  const compact = output.filter(Boolean);
  if (!compact.some((item) => item.type === "message" || item.type === "function_call")) {
    throw invalidProviderResponse("Anthropic 响应没有可继续处理的完成内容。");
  }
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
  if (!isRecord(payload) || !Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    throw invalidProviderResponse("Gemini 响应缺少候选结果。");
  }
  const candidate = payload.candidates[0];
  if (
    !isRecord(candidate) ||
    typeof candidate.finishReason !== "string" ||
    candidate.finishReason === "" ||
    !isRecord(candidate.content) ||
    !Array.isArray(candidate.content.parts) ||
    candidate.content.parts.length === 0
  ) {
    throw invalidProviderResponse("Gemini 响应候选结果未完成或内容无效。");
  }
  const output = [];
  const parts = candidate.content.parts;
  for (const part of parts) {
    if (!isRecord(part)) {
      throw invalidProviderResponse("Gemini 响应包含无效内容块。");
    }
    let handled = false;
    if (hasOwn(part, "text")) {
      if (typeof part.text !== "string") {
        throw invalidProviderResponse("Gemini 文本内容块无效。");
      }
      handled = true;
    }
    if (typeof part.text === "string" && part.text !== "") {
      if (part.thought === true) output.push({ type: "reasoning", thinking: part.text });
      else output.push(normalizedMessage("assistant", part.text));
    }
    if (hasOwn(part, "functionCall")) {
      if (
        !isRecord(part.functionCall) ||
        typeof part.functionCall.name !== "string" ||
        part.functionCall.name === "" ||
        (hasOwn(part.functionCall, "id") && (typeof part.functionCall.id !== "string" || part.functionCall.id === "")) ||
        (hasOwn(part.functionCall, "args") && !isRecord(part.functionCall.args))
      ) {
        throw invalidProviderResponse("Gemini 工具调用内容块无效。");
      }
      handled = true;
      const callId = part.functionCall.id ?? `gemini-call-${output.length + 1}`;
      output.push({
        type: "function_call",
        name: part.functionCall.name,
        call_id: callId,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
    if (!handled) throw invalidProviderResponse("Gemini 响应包含不受支持的内容块。");
  }
  const compact = output.filter(Boolean);
  if (!compact.some((item) => item.type === "message" || item.type === "function_call")) {
    throw invalidProviderResponse("Gemini 响应没有可继续处理的完成内容。");
  }
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

function requestBodyFor(protocol, config, input, toolDefinitions, { stream = false } = {}) {
  const officialCapabilities = resolveOfficialModelCapabilities(protocol, config.model);
  const usesThinkingToggle = officialCapabilities?.thinkingToggle === true;
  const usesQwenThinkingToggle = usesThinkingToggle
    && officialCapabilities?.reasoningMode === "thinking-toggle";
  const usesDeepSeekThinkingToggle = usesThinkingToggle && !usesQwenThinkingToggle;
  const deepSeekReasoningEffort = config.reasoningEffort
    ?? officialCapabilities?.defaultReasoningEffort
    ?? "high";
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
    if (stream) body.stream = true;
    if (usesDeepSeekThinkingToggle) {
      body.reasoning = { effort: deepSeekReasoningEffort };
    } else if (config.reasoningEffort !== null && config.reasoningEffort !== undefined) {
      body.reasoning = {
        effort: config.reasoningEffort,
        ...(config.reasoningEffort === "none" ? {} : { summary: "auto" }),
      };
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
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (usesDeepSeekThinkingToggle) {
      body.thinking = { type: deepSeekReasoningEffort === "none" ? "disabled" : "enabled" };
      if (deepSeekReasoningEffort !== "none") body.reasoning_effort = deepSeekReasoningEffort;
    } else if (usesQwenThinkingToggle) {
      if (config.reasoningEffort === "none") body.enable_thinking = false;
    } else if (config.reasoningEffort !== null && config.reasoningEffort !== undefined) {
      body.reasoning_effort = config.reasoningEffort;
    }
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
    if (stream) body.stream = true;
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
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数。" );
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0) {
    throw new TypeError("reconnectDelayMs 必须是非负整数。" );
  }
  if (!Number.isSafeInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) {
    throw new TypeError("maxReconnectAttempts 必须是非负整数。" );
  }
  return {
    async create({ input, signal, options, onEvent } = {}) {
      if (!Array.isArray(input)) throw new TypeError("Provider input 必须是数组。" );
      const config = await configLoader(options);
      const token = validateProviderToken(config.token);
      const protocol = resolveProtocol(config);
      const endpoint = config.endpoint ?? config.responsesUrl;
      if (typeof endpoint !== "string" || endpoint === "") {
        throw new ProviderError("PROVIDER_ENDPOINT_MISSING", "当前协议缺少生成接口地址。", { statusCode: 500 });
      }
      const streaming = typeof onEvent === "function";
      const requestEndpoint = streaming ? streamingEndpoint(protocol, endpoint) : endpoint;
      const abort = combineAbortSignal(signal, timeoutMs);
      try {
        const request = {
          method: "POST",
          headers: {
            ...protocolAuthHeaders(protocol, token),
            "Content-Type": "application/json",
            ...(streaming ? { Accept: "text/event-stream" } : {}),
          },
          body: JSON.stringify(requestBodyFor(protocol, config, input, toolDefinitions, { stream: streaming })),
          signal: abort.signal,
        };
        let reconnectAttempt = 0;
        const reconnect = async (discardTextLength) => {
          const stopped = interruptionError(signal, abort);
          if (stopped) throw stopped;
          if (discardTextLength > 0) {
            onEvent?.({ type: "stream_reset", discardTextLength });
          }
          if (reconnectAttempt >= maxReconnectAttempts) {
            throw new ProviderError("PROVIDER_UNAVAILABLE", "无法连接当前模型提供方。", { statusCode: 502 });
          }

          reconnectAttempt += 1;
          onEvent?.({
            type: "provider_reconnecting",
            attempt: reconnectAttempt,
            maxAttempts: maxReconnectAttempts,
            delayMs: reconnectDelayMs,
          });
          await waitForReconnect(reconnectDelayMs, abort.signal);
          const interrupted = interruptionError(signal, abort);
          if (interrupted) throw interrupted;
        };

        while (true) {
          let response;
          try {
            response = await fetchImpl(requestEndpoint, request);
          } catch (error) {
            const interrupted = interruptionError(signal, abort);
            if (interrupted) throw interrupted;
            if (!isRetryableTransportError(error)) {
              throw new ProviderError("PROVIDER_UNAVAILABLE", "无法连接当前模型提供方。", { statusCode: 502 });
            }
            await reconnect(false);
            continue;
          }

          const requestId = response.headers.get("x-request-id");
          if (!response.ok) {
            let summary = "";
            try {
              summary = sanitizeSummary(await response.text(), token);
            } catch {
              // HTTP status is already terminal even when its body disconnects during reading.
            }
            throw new ProviderError(
              "PROVIDER_HTTP_ERROR",
              summary ? `模型提供方返回 HTTP ${response.status}：${summary}` : `模型提供方返回 HTTP ${response.status}。`,
              { statusCode: 502, providerStatus: response.status, requestId },
            );
          }

          let payload;
          let streamedTextLength = 0;
          try {
            payload = await readProviderResponse(response, {
              protocol,
              onEvent: streaming
                ? (event) => {
                    if (event?.type === "text_delta" && typeof event.text === "string" && event.text !== "") {
                      streamedTextLength += event.text.length;
                    }
                    onEvent(event);
                  }
                : undefined,
              signal: abort.signal,
            });
          } catch (error) {
            const interrupted = interruptionError(signal, abort);
            if (interrupted) throw interrupted;
            if (isRetryableTransportError(error)) {
              await reconnect(streamedTextLength);
              continue;
            }
            const code = error?.code === "PROVIDER_STREAM_ERROR"
              ? "PROVIDER_STREAM_ERROR"
              : "PROVIDER_RESPONSE_INVALID";
            throw new ProviderError(
              code,
              code === "PROVIDER_STREAM_ERROR"
                ? sanitizeSummary(error instanceof Error ? error.message : "模型提供方返回了流式错误。", token)
                : "模型提供方返回了无效 JSON。",
              { statusCode: 502, requestId },
            );
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
        }
      } finally {
        abort.cleanup();
      }
    },
  };
}

export const createResponsesClient = createProviderClient;
