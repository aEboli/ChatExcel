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
const MAX_WORKBOOK_BINDING_LENGTH = 512;

const RECOVERY_PHASES = Object.freeze({
  stable: "stable",
  modelRequest: "model_request_in_flight",
  toolCalls: "tool_calls_pending",
});

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

function validateWorkbookBinding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AgentSessionError("WORKBOOK_BINDING_INVALID", "工作簿恢复标识格式无效。", 400);
  }
  const normalized = value.trim();
  if (normalized === "" || normalized.length > MAX_WORKBOOK_BINDING_LENGTH) {
    throw new AgentSessionError("WORKBOOK_BINDING_INVALID", "工作簿恢复标识格式无效。", 400);
  }
  return normalized;
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

function recoverableToolOutput(code, message, path) {
  return {
    ok: false,
    error: {
      code,
      message,
      path,
      recoverable: true,
    },
  };
}

function parseFunctionCalls(output) {
  const calls = [];
  const recoveryOutputs = [];
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
    callIds.add(item.call_id);

    const tool = typeof item.name === "string" ? getToolDefinition(item.name) : null;
    if (!tool) {
      recoveryOutputs.push({
        type: "function_call_output",
        call_id: item.call_id,
        output: serializeToolOutput(recoverableToolOutput(
          "TOOL_UNKNOWN",
          "模型请求了未知 Excel 工具。请从已提供的工具列表中选择并重试。",
          "$.name",
        )),
      });
      continue;
    }

    let args;
    try {
      args = parseAndValidateToolArguments(item.name, item.arguments);
    } catch (error) {
      if (error instanceof ToolValidationError) {
        recoveryOutputs.push({
          type: "function_call_output",
          call_id: item.call_id,
          output: serializeToolOutput(recoverableToolOutput(error.code, error.message, error.path)),
        });
        continue;
      }
      throw error;
    }

    calls.push({
      callId: item.call_id,
      name: item.name,
      label: tool.label,
      mode: tool.mode,
      arguments: args,
    });
  }

  return { calls, recoveryOutputs };
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

function visibleText(content, type) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === type && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function visiblePresentation(input) {
  if (!Array.isArray(input)) return { messages: [] };
  const messages = [];
  for (const item of input) {
    const userText = item?.role === "user" ? visibleText(item.content, "input_text") : "";
    if (userText !== "") {
      messages.push({ role: "user", text: userText });
      continue;
    }
    const assistantText = item?.type === "message" && item.role === "assistant"
      ? visibleText(item.content, "output_text")
      : "";
    if (assistantText !== "") {
      messages.push({ role: "assistant", text: assistantText });
    }
  }
  return { messages };
}

function interruptedToolOutput(call) {
  return recoverableToolOutput(
    "TOOL_EXECUTION_INTERRUPTED",
    `上一次“${call.label ?? call.name}”在任务窗格或本地服务中断时未确认完成。请重新读取工作簿，并在需要修改时重新请求审批。`,
    "$.tool",
  );
}

function isRecoverableProviderFailure(error) {
  return typeof error?.code === "string"
    && error.code.startsWith("PROVIDER_")
    && error.code !== "PROVIDER_AUTH_INVALID";
}

function publicRecoveryTouchStatus(value) {
  return ["touched", "expired", "unavailable"].includes(value?.status)
    ? value.status
    : "missing";
}

export class SessionManager {
  constructor({
    responsesClient,
    maxSteps = DEFAULT_MAX_STEPS,
    maxStepsProvider = null,
    recoveryStore = null,
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
    if (
      recoveryStore !== null &&
      (
        typeof recoveryStore.save !== "function" ||
        typeof recoveryStore.restore !== "function" ||
        typeof recoveryStore.clear !== "function" ||
        typeof recoveryStore.touch !== "function"
      )
    ) {
      throw new TypeError("recoveryStore 必须提供保存、恢复、心跳和清除方法。" );
    }
    this.recoveryStore = recoveryStore;
    this.idleTtlMs = idleTtlMs;
    this.now = now;
    this.sessions = new Map();
    this.sweepTimer = setInterval(() => this.cleanupExpired(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async start(message, requestedId, options = {}, hooks = {}) {
    const sessionId = validateRequestedId(requestedId);
    if (this.sessions.has(sessionId)) {
      throw new AgentSessionError("SESSION_EXISTS", "该会话 ID 已存在。", 409);
    }

    const payload = validateUserPayload(message, options.attachments);
    const workbookBinding = validateWorkbookBinding(options.workbookBinding);
    const startedAt = this.now();
    const session = {
      id: sessionId,
      input: [userInput(payload.message, payload.attachments)],
      requestOptions: validateRequestOptions(options),
      workbookBinding,
      stepCount: 0,
      state: "idle",
      pendingCalls: null,
      abortController: null,
      streamSink: typeof hooks.onEvent === "function" ? hooks.onEvent : null,
      lastTouched: startedAt,
      lastPaneHeartbeatAt: this.recoveryStore && workbookBinding ? startedAt : null,
      recoveryPhase: RECOVERY_PHASES.stable,
      recoveryNotice: null,
      suspendedForRecovery: false,
      cancelled: false,
    };
    this.sessions.set(sessionId, session);

    try {
      return await this.#advance(session);
    } catch (error) {
      await this.#handleFailure(session, error);
      throw error;
    }
  }

  async addMessage(sessionId, message, options = {}, hooks = {}) {
    const session = this.#getSession(sessionId);
    if (session.state !== "idle" || session.pendingCalls) {
      throw new AgentSessionError("SESSION_BUSY", "当前会话仍在处理上一项操作。", 409);
    }
    const payload = validateUserPayload(message, options.attachments);
    session.requestOptions = validateRequestOptions(options, session.requestOptions);
    session.streamSink = typeof hooks.onEvent === "function" ? hooks.onEvent : null;
    session.input.push(userInput(payload.message, payload.attachments));
    session.lastTouched = this.now();

    try {
      return await this.#advance(session);
    } catch (error) {
      await this.#handleFailure(session, error);
      throw error;
    }
  }

  async submitToolResults(sessionId, results, hooks = {}) {
    const session = this.#getSession(sessionId);
    try {
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
      session.streamSink = typeof hooks.onEvent === "function" ? hooks.onEvent : null;
      session.lastTouched = this.now();

      return await this.#advance(session);
    } catch (error) {
      await this.#handleFailure(session, error);
      throw error;
    }
  }

  async cancel(sessionId) {
    const session = this.sessions.get(sessionId) ?? null;
    this.#removeSession(sessionId);
    const cleared = await this.#clearRecovery(sessionId, session?.workbookBinding ?? null);
    return Boolean(session) || cleared;
  }

  async suspend(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.suspendedForRecovery = true;
    session.lastTouched = this.now();
    const phase = session.pendingCalls
      ? RECOVERY_PHASES.toolCalls
      : session.state === "requesting"
        ? RECOVERY_PHASES.modelRequest
        : RECOVERY_PHASES.stable;
    this.sessions.delete(sessionId);
    await this.#checkpoint(session, phase);
    session.abortController?.abort();
    return true;
  }

  async restore(workbookBinding) {
    const normalizedBinding = validateWorkbookBinding(workbookBinding);
    if (!normalizedBinding || !this.recoveryStore) return null;

    const restored = await this.recoveryStore.restore({ workbookKey: normalizedBinding });
    if (restored?.status !== "available") {
      return {
        recovery: {
          status: typeof restored?.status === "string" ? restored.status : "missing",
        },
      };
    }
    const snapshot = restored.snapshot;
    let session;
    try {
      session = this.#hydrateRecoverySnapshot(
        snapshot,
        normalizedBinding,
        restored.lastPaneHeartbeatAt,
      );
    } catch {
      await this.#clearRecovery(restored.sessionId, normalizedBinding);
      return null;
    }
    const existing = this.sessions.get(session.id);
    if (existing) {
      if (existing.workbookBinding !== normalizedBinding) return null;
      if (existing.state !== "idle" || existing.pendingCalls) {
        await this.suspend(existing.id);
        return this.restore(normalizedBinding);
      }
      const previousPaneHeartbeatAt = existing.lastPaneHeartbeatAt;
      existing.lastPaneHeartbeatAt = this.now();
      const checkpointed = await this.#checkpoint(existing, existing.recoveryPhase);
      if (!checkpointed) existing.lastPaneHeartbeatAt = previousPaneHeartbeatAt;
      return this.#recoveryPayload(existing);
    }

    const phase = snapshot.recovery?.phase;
    if (phase === RECOVERY_PHASES.toolCalls && session.pendingCalls?.length) {
      session.input.push(...session.pendingCalls.map((call) => ({
        type: "function_call_output",
        call_id: call.callId,
        output: serializeToolOutput(interruptedToolOutput(call)),
      })));
      session.pendingCalls = null;
      session.recoveryNotice = "tool_execution_interrupted";
    } else if (phase === RECOVERY_PHASES.modelRequest) {
      session.recoveryNotice = "model_request_interrupted";
    }
    session.state = "idle";
    const previousPaneHeartbeatAt = session.lastPaneHeartbeatAt;
    const restoredAt = this.now();
    session.lastTouched = restoredAt;
    session.lastPaneHeartbeatAt = restoredAt;
    session.recoveryPhase = RECOVERY_PHASES.stable;
    this.sessions.set(session.id, session);
    const checkpointed = await this.#checkpoint(session, RECOVERY_PHASES.stable);
    if (!checkpointed) session.lastPaneHeartbeatAt = previousPaneHeartbeatAt;
    return this.#recoveryPayload(session);
  }

  async touchRecovery(sessionId, workbookBinding) {
    const normalizedBinding = validateWorkbookBinding(workbookBinding);
    if (!normalizedBinding || !this.recoveryStore) return { status: "missing" };
    if (typeof sessionId !== "string" || sessionId.trim() === "" || sessionId.length > 160) {
      return { status: "missing" };
    }
    const normalizedSessionId = sessionId.trim();
    const session = this.sessions.get(normalizedSessionId);
    if (session) {
      if (session.workbookBinding !== normalizedBinding) return { status: "missing" };
      const previousPaneHeartbeatAt = session.lastPaneHeartbeatAt;
      session.lastPaneHeartbeatAt = this.now();
      const checkpointed = await this.#checkpoint(session, session.recoveryPhase);
      if (!checkpointed) session.lastPaneHeartbeatAt = previousPaneHeartbeatAt;
      return { status: checkpointed ? "touched" : "unavailable" };
    }
    try {
      const touched = await this.recoveryStore.touch({
        sessionId: normalizedSessionId,
        workbookKey: normalizedBinding,
      });
      return { status: publicRecoveryTouchStatus(touched) };
    } catch {
      return { status: "unavailable" };
    }
  }

  cleanupExpired() {
    const cutoff = this.now() - this.idleTtlMs;
    for (const [sessionId, session] of this.sessions) {
      const expirationTimestamp = this.recoveryStore && session.workbookBinding &&
        Number.isSafeInteger(session.lastPaneHeartbeatAt)
        ? session.lastPaneHeartbeatAt
        : session.lastTouched;
      if (expirationTimestamp <= cutoff) {
        this.#removeSession(sessionId);
      }
    }
    void this.recoveryStore?.cleanupExpired?.();
  }

  async dispose() {
    clearInterval(this.sweepTimer);
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) =>
        this.suspend(sessionId).catch(() => this.#removeSession(sessionId))),
    );
  }

  async #handleFailure(session, error) {
    if (session.cancelled || session.suspendedForRecovery) return;
    if (this.recoveryStore && session.workbookBinding && isRecoverableProviderFailure(error)) {
      session.abortController = null;
      session.pendingCalls = null;
      session.state = "idle";
      session.lastTouched = this.now();
      session.recoveryNotice = "model_request_interrupted";
      await this.#checkpoint(session, RECOVERY_PHASES.modelRequest);
      error.recoverableSession = true;
      return;
    }
    this.#removeSession(session.id);
    await this.#clearRecovery(session.id, session.workbookBinding);
  }

  async #checkpoint(session, phase) {
    session.recoveryPhase = phase;
    if (!this.recoveryStore || !session.workbookBinding) return false;
    try {
      await this.recoveryStore.save({
        sessionId: session.id,
        workbookKey: session.workbookBinding,
        lastPaneHeartbeatAt: session.lastPaneHeartbeatAt,
        snapshot: {
          version: 1,
          lastActiveAt: session.lastTouched,
          workbook: { binding: session.workbookBinding },
          session: {
            id: session.id,
            input: structuredClone(session.input),
            requestOptions: structuredClone(session.requestOptions),
            stepCount: session.stepCount,
            state: session.state,
            pendingCalls: structuredClone(session.pendingCalls),
            lastTouched: session.lastTouched,
            lastPaneHeartbeatAt: session.lastPaneHeartbeatAt,
          },
          recovery: {
            phase,
            notice: session.recoveryNotice,
          },
          presentation: visiblePresentation(session.input),
        },
      });
      if (session.recoveryUnavailable) {
        session.recoveryUnavailable = false;
        session.streamSink?.({ type: "recovery_available" });
      }
      return true;
    } catch {
      if (!session.recoveryUnavailable) {
        session.recoveryUnavailable = true;
        session.streamSink?.({ type: "recovery_unavailable" });
      }
      return false;
    }
  }

  async #clearRecovery(sessionId, workbookBinding) {
    if (!this.recoveryStore) return false;
    try {
      const cleared = await this.recoveryStore.clear({
        sessionId,
        ...(workbookBinding ? { workbookKey: workbookBinding } : {}),
      });
      return cleared?.status === "cleared";
    } catch {
      return false;
    }
  }

  #hydrateRecoverySnapshot(snapshot, workbookBinding, lastPaneHeartbeatAt) {
    const rawSession = snapshot?.session;
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      snapshot.workbook?.binding !== workbookBinding ||
      !rawSession ||
      typeof rawSession !== "object" ||
      !Array.isArray(rawSession.input) ||
      !Number.isSafeInteger(rawSession.stepCount) ||
      rawSession.stepCount < 0
    ) {
      throw new AgentSessionError("RECOVERY_INVALID", "本地会话恢复数据无效。", 409);
    }
    const pendingCalls = rawSession.pendingCalls === null || rawSession.pendingCalls === undefined
      ? null
      : rawSession.pendingCalls;
    if (
      pendingCalls !== null &&
      (!Array.isArray(pendingCalls) || pendingCalls.some((call) =>
        !call || typeof call.callId !== "string" || typeof call.name !== "string"))
    ) {
      throw new AgentSessionError("RECOVERY_INVALID", "本地会话恢复数据无效。", 409);
    }
    const restoredAt = this.now();
    return {
      id: validateRequestedId(rawSession.id),
      input: structuredClone(rawSession.input),
      requestOptions: validateRequestOptions(rawSession.requestOptions),
      workbookBinding,
      stepCount: rawSession.stepCount,
      state: "idle",
      pendingCalls: pendingCalls === null ? null : structuredClone(pendingCalls),
      abortController: null,
      streamSink: null,
      lastTouched: restoredAt,
      lastPaneHeartbeatAt: Number.isSafeInteger(lastPaneHeartbeatAt)
        ? lastPaneHeartbeatAt
        : restoredAt,
      recoveryPhase: RECOVERY_PHASES.stable,
      recoveryNotice: typeof snapshot.recovery?.notice === "string" ? snapshot.recovery.notice : null,
      suspendedForRecovery: false,
      cancelled: false,
      recoveryUnavailable: false,
    };
  }

  #recoveryPayload(session) {
    return {
      sessionId: session.id,
      presentation: visiblePresentation(session.input),
      recovery: {
        notice: session.recoveryNotice,
      },
    };
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
    if (session) session.cancelled = true;
    session?.abortController?.abort();
    this.sessions.delete(sessionId);
  }

  async #advance(session) {
    const streamSink = session.streamSink;
    try {
      while (true) {
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
        session.recoveryNotice = null;
        await this.#checkpoint(session, RECOVERY_PHASES.modelRequest);
        if (session.cancelled || session.suspendedForRecovery || session.abortController.signal.aborted) {
          throw new AgentSessionError("AGENT_CANCELLED", "当前 Agent 请求已停止。", 499);
        }
        let response;
        try {
          response = await this.responsesClient.create({
            input: session.input,
            signal: session.abortController.signal,
            options: session.requestOptions,
            onEvent: streamSink,
          });
        } finally {
          session.abortController = null;
        }

        if (session.cancelled || session.suspendedForRecovery) {
          throw new AgentSessionError("AGENT_CANCELLED", "当前 Agent 请求已停止。", 499);
        }

        session.stepCount += 1;
        session.lastTouched = this.now();
        const output = structuredClone(response.output);
        const { calls, recoveryOutputs } = parseFunctionCalls(output);
        const context = responseContext(response);
        session.input.push(...output, ...recoveryOutputs);

        if (calls.length > 0) {
          if (session.stepCount >= this.#currentMaxSteps()) {
            throw new AgentSessionError(
              "STEP_LIMIT_EXCEEDED",
              `Agent 已达到 ${this.#currentMaxSteps()} 个模型步骤上限。`,
              409,
            );
          }
          session.pendingCalls = calls;
          session.state = "waiting_for_tools";
          await this.#checkpoint(session, RECOVERY_PHASES.toolCalls);
          if (session.cancelled || session.suspendedForRecovery) {
            throw new AgentSessionError("AGENT_CANCELLED", "当前 Agent 请求已停止。", 499);
          }
          return {
            sessionId: session.id,
            status: "requires_action",
            step: session.stepCount,
            context,
            toolCalls: calls,
          };
        }

        if (recoveryOutputs.length > 0) {
          streamSink?.({ type: "model_step_boundary" });
          session.state = "idle";
          await this.#checkpoint(session, RECOVERY_PHASES.stable);
          if (session.cancelled || session.suspendedForRecovery) {
            throw new AgentSessionError("AGENT_CANCELLED", "当前 Agent 请求已停止。", 499);
          }
          continue;
        }

        session.state = "idle";
        await this.#checkpoint(session, RECOVERY_PHASES.stable);
        if (session.cancelled || session.suspendedForRecovery) {
          throw new AgentSessionError("AGENT_CANCELLED", "当前 Agent 请求已停止。", 499);
        }
        return {
          sessionId: session.id,
          status: "completed",
          step: session.stepCount,
          context,
          message: extractOutputText(response),
        };
      }
    } finally {
      session.streamSink = null;
    }
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
