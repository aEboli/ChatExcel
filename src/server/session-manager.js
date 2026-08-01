import { randomUUID } from "node:crypto";
import {
  getToolDefinition,
  parseAndValidateToolArguments,
  ToolValidationError,
} from "../shared/excel-tools.js";
import { REASONING_EFFORTS } from "./config.js";
import { DEFAULT_MAX_STEPS, normalizeMaxSteps } from "./limits.js";

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_IMAGE_TOTAL_BYTES = 5_500_000;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export class AgentSessionError extends Error {
  constructor(code, message, statusCode = 400, options = {}) {
    super(message, options);
    this.name = "AgentSessionError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function validateAttachments(attachments) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) {
    throw new AgentSessionError("ATTACHMENTS_INVALID", "图片附件格式无效。", 400);
  }
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) {
    throw new AgentSessionError(
      "ATTACHMENTS_TOO_MANY",
      `每条消息最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`,
      400,
    );
  }

  let totalBytes = 0;
  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new AgentSessionError("ATTACHMENT_INVALID", `第 ${index + 1} 张图片格式无效。`, 400);
    }
    const dataUrl = attachment.dataUrl;
    if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 128) {
      throw new AgentSessionError("ATTACHMENT_TOO_LARGE", `第 ${index + 1} 张图片超过大小限制。`, 400);
    }
    const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
    if (!match) {
      throw new AgentSessionError(
        "ATTACHMENT_TYPE_UNSUPPORTED",
        "图片只支持 PNG、JPEG 或 WebP。",
        400,
      );
    }
    const byteLength = Buffer.from(match[2], "base64").byteLength;
    if (byteLength === 0 || byteLength > MAX_IMAGE_BYTES) {
      throw new AgentSessionError("ATTACHMENT_TOO_LARGE", `第 ${index + 1} 张图片超过大小限制。`, 400);
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new AgentSessionError("ATTACHMENTS_TOO_LARGE", "图片附件总大小超过限制。", 400);
    }
    return {
      name:
        typeof attachment.name === "string" && attachment.name.trim() !== ""
          ? attachment.name.trim().slice(0, 160)
          : `图片 ${index + 1}`,
      mimeType: match[1],
      dataUrl,
    };
  });
}

function validateUserPayload(message, attachments) {
  if (typeof message !== "string") {
    throw new AgentSessionError("MESSAGE_REQUIRED", "请输入要交给 ChatExcel 的任务。", 400);
  }
  if (message.length > 20_000) {
    throw new AgentSessionError("MESSAGE_TOO_LONG", "单条消息不能超过 20000 个字符。", 400);
  }
  const normalizedMessage = message.trim();
  const normalizedAttachments = validateAttachments(attachments);
  if (normalizedMessage === "" && normalizedAttachments.length === 0) {
    throw new AgentSessionError("MESSAGE_REQUIRED", "请输入任务或添加图片。", 400);
  }
  return { message: normalizedMessage, attachments: normalizedAttachments };
}

function validateRequestOptions(options, fallback = {}) {
  const value = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const model = value.model === undefined ? fallback.model : value.model;
  if (model !== undefined && (typeof model !== "string" || !MODEL_ID_PATTERN.test(model.trim()))) {
    throw new AgentSessionError("MODEL_ID_INVALID", "模型 ID 格式无效。", 400);
  }
  const reasoningEffort = value.reasoningEffort === undefined
    ? fallback.reasoningEffort
    : value.reasoningEffort;
  if (
    reasoningEffort !== undefined &&
    reasoningEffort !== null &&
    !REASONING_EFFORTS.includes(reasoningEffort)
  ) {
    throw new AgentSessionError("REASONING_EFFORT_INVALID", "思考等级无效。", 400);
  }
  return {
    ...(model === undefined ? {} : { model: model.trim() }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function validateRequestedId(requestedId) {
  if (requestedId === undefined) {
    return randomUUID();
  }
  if (typeof requestedId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(requestedId)) {
    throw new AgentSessionError("SESSION_ID_INVALID", "会话 ID 格式无效。", 400);
  }
  return requestedId;
}

function userInput(message, attachments) {
  const content = [];
  if (message !== "") {
    content.push({ type: "input_text", text: message });
  }
  for (const attachment of attachments) {
    content.push({ type: "input_image", image_url: attachment.dataUrl });
  }
  return {
    role: "user",
    content,
  };
}

function responseContext(response) {
  const runtime = response?.__chatExcel;
  const contextWindow = Number.isSafeInteger(runtime?.contextWindow)
    ? runtime.contextWindow
    : null;
  const usage = response?.usage;
  const usedTokens = Number.isSafeInteger(usage?.total_tokens)
    ? usage.total_tokens
    : Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens)
      ? usage.input_tokens + usage.output_tokens
      : null;
  if (!contextWindow || usedTokens === null) {
    return {
      status: "unknown",
      usedTokens,
      limitTokens: contextWindow,
      percent: null,
      model: typeof runtime?.model === "string" ? runtime.model : null,
    };
  }
  return {
    status: "available",
    usedTokens,
    limitTokens: contextWindow,
    percent: Math.min(100, Math.max(0, Math.round(usedTokens / contextWindow * 100))),
    model: typeof runtime?.model === "string" ? runtime.model : null,
  };
}

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text.trim();
  }

  const parts = [];
  for (const item of response.output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function protocolError(code, message, cause) {
  return new AgentSessionError(code, message, 502, cause ? { cause } : {});
}

function parseFunctionCalls(output) {
  const calls = [];
  const callIds = new Set();

  for (const item of output) {
    if (item?.type !== "function_call") {
      continue;
    }
    if (typeof item.call_id !== "string" || item.call_id.trim() === "") {
      throw protocolError("TOOL_CALL_ID_MISSING", "模型工具调用缺少 call_id。" );
    }
    if (callIds.has(item.call_id)) {
      throw protocolError("TOOL_CALL_ID_DUPLICATE", "模型返回了重复的 call_id。" );
    }
    if (typeof item.name !== "string" || !getToolDefinition(item.name)) {
      throw protocolError("TOOL_UNKNOWN", `模型请求了未知工具：${item.name ?? "(missing)"}`);
    }

    let args;
    try {
      args = parseAndValidateToolArguments(item.name, item.arguments);
    } catch (error) {
      if (error instanceof ToolValidationError) {
        throw protocolError(error.code, error.message, error);
      }
      throw error;
    }

    callIds.add(item.call_id);
    const tool = getToolDefinition(item.name);
    calls.push({
      callId: item.call_id,
      name: item.name,
      label: tool.label,
      mode: tool.mode,
      arguments: args,
    });
  }

  return calls;
}

function serializeToolOutput(output) {
  if (output === undefined) {
    throw new AgentSessionError("TOOL_RESULT_INVALID", "工具结果不能是 undefined。", 400);
  }
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch (error) {
    throw new AgentSessionError("TOOL_RESULT_INVALID", "工具结果无法序列化。", 400, {
      cause: error,
    });
  }
}

export class SessionManager {
  constructor({
    responsesClient,
    maxSteps = DEFAULT_MAX_STEPS,
    maxStepsProvider = null,
    idleTtlMs = 30 * 60 * 1_000,
    sweepIntervalMs = 60_000,
    now = () => Date.now(),
  } = {}) {
    if (!responsesClient || typeof responsesClient.create !== "function") {
      throw new TypeError("SessionManager 需要 Responses 客户端。" );
    }
    this.responsesClient = responsesClient;
    this.maxSteps = normalizeMaxSteps(maxSteps);
    if (maxStepsProvider !== null && typeof maxStepsProvider !== "function") {
      throw new TypeError("maxStepsProvider 必须是函数。" );
    }
    this.maxStepsProvider = maxStepsProvider;
    this.idleTtlMs = idleTtlMs;
    this.now = now;
    this.sessions = new Map();
    this.sweepTimer = setInterval(() => this.cleanupExpired(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async start(message, requestedId, options = {}) {
    const sessionId = validateRequestedId(requestedId);
    if (this.sessions.has(sessionId)) {
      throw new AgentSessionError("SESSION_EXISTS", "该会话 ID 已存在。", 409);
    }

    const payload = validateUserPayload(message, options.attachments);
    const session = {
      id: sessionId,
      input: [userInput(payload.message, payload.attachments)],
      requestOptions: validateRequestOptions(options),
      stepCount: 0,
      state: "idle",
      pendingCalls: null,
      abortController: null,
      lastTouched: this.now(),
    };
    this.sessions.set(sessionId, session);

    try {
      return await this.#advance(session);
    } catch (error) {
      this.#removeSession(sessionId);
      throw error;
    }
  }

  async addMessage(sessionId, message, options = {}) {
    const session = this.#getSession(sessionId);
    if (session.state !== "idle" || session.pendingCalls) {
      throw new AgentSessionError("SESSION_BUSY", "当前会话仍在处理上一项操作。", 409);
    }
    const payload = validateUserPayload(message, options.attachments);
    session.requestOptions = validateRequestOptions(options, session.requestOptions);
    session.input.push(userInput(payload.message, payload.attachments));
    session.lastTouched = this.now();

    try {
      return await this.#advance(session);
    } catch (error) {
      this.#removeSession(sessionId);
      throw error;
    }
  }

  async submitToolResults(sessionId, results) {
    const session = this.#getSession(sessionId);
    if (session.state !== "waiting_for_tools" || !session.pendingCalls) {
      throw new AgentSessionError("TOOL_RESULTS_UNEXPECTED", "当前会话没有等待工具结果。", 409);
    }
    if (!Array.isArray(results) || results.length !== session.pendingCalls.length) {
      throw new AgentSessionError(
        "TOOL_RESULT_MISMATCH",
        "工具结果数量与模型调用数量不一致。",
        400,
      );
    }

    const resultsByCallId = new Map();
    for (const result of results) {
      if (!result || typeof result !== "object" || typeof result.callId !== "string") {
        throw new AgentSessionError("TOOL_RESULT_INVALID", "工具结果缺少 callId。", 400);
      }
      if (resultsByCallId.has(result.callId)) {
        throw new AgentSessionError("TOOL_RESULT_MISMATCH", "工具结果包含重复 callId。", 400);
      }
      resultsByCallId.set(result.callId, result);
    }

    const outputItems = [];
    for (const call of session.pendingCalls) {
      const result = resultsByCallId.get(call.callId);
      if (!result || result.name !== call.name) {
        throw new AgentSessionError(
          "TOOL_RESULT_MISMATCH",
          `工具结果与 ${call.callId} 不匹配。`,
          400,
        );
      }
      outputItems.push({
        type: "function_call_output",
        call_id: call.callId,
        output: serializeToolOutput(result.output),
      });
    }

    session.input.push(...outputItems);
    session.pendingCalls = null;
    session.state = "idle";
    session.lastTouched = this.now();

    try {
      return await this.#advance(session);
    } catch (error) {
      this.#removeSession(sessionId);
      throw error;
    }
  }

  async cancel(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    this.#removeSession(sessionId);
    return true;
  }

  cleanupExpired() {
    const cutoff = this.now() - this.idleTtlMs;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastTouched <= cutoff) {
        this.#removeSession(sessionId);
      }
    }
  }

  dispose() {
    clearInterval(this.sweepTimer);
    for (const sessionId of [...this.sessions.keys()]) {
      this.#removeSession(sessionId);
    }
  }

  #getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentSessionError("SESSION_NOT_FOUND", "Agent 会话不存在或已过期。", 404);
    }
    return session;
  }

  #removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    session?.abortController?.abort();
    this.sessions.delete(sessionId);
  }

  async #advance(session) {
    const maxSteps = this.#currentMaxSteps();
    if (session.stepCount >= maxSteps) {
      throw new AgentSessionError(
        "STEP_LIMIT_EXCEEDED",
        `Agent 已达到 ${maxSteps} 个模型步骤上限。`,
        409,
      );
    }

    session.state = "requesting";
    session.abortController = new AbortController();
    session.lastTouched = this.now();
    let response;
    try {
      response = await this.responsesClient.create({
        input: session.input,
        signal: session.abortController.signal,
        options: session.requestOptions,
      });
    } finally {
      session.abortController = null;
    }

    session.stepCount += 1;
    session.lastTouched = this.now();
    const output = structuredClone(response.output);
    const calls = parseFunctionCalls(output);
    const context = responseContext(response);
    session.input.push(...output);

    if (calls.length > 0) {
      if (session.stepCount >= maxSteps) {
        throw new AgentSessionError(
          "STEP_LIMIT_EXCEEDED",
          `Agent 已达到 ${maxSteps} 个模型步骤上限。`,
          409,
        );
      }
      session.pendingCalls = calls;
      session.state = "waiting_for_tools";
      return {
        sessionId: session.id,
        status: "requires_action",
        step: session.stepCount,
        context,
        toolCalls: calls,
      };
    }

    session.state = "idle";
    return {
      sessionId: session.id,
      status: "completed",
      step: session.stepCount,
      context,
      message: extractOutputText(response),
    };
  }

  #currentMaxSteps() {
    const value = this.maxStepsProvider ? this.maxStepsProvider() : this.maxSteps;
    try {
      return normalizeMaxSteps(value);
    } catch {
      return this.maxSteps;
    }
  }
}
