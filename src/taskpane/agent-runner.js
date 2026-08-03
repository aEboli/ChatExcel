import {
  getToolDefinition,
  parseAndValidateToolArguments,
} from "../shared/excel-tools.js";

export class AgentRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentRunnerError";
    this.code = code;
  }
}

function makeSessionId() {
  return globalThis.crypto?.randomUUID?.() ??
    `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function cancelledResult() {
  return {
    ok: false,
    error: {
      code: "USER_DENIED",
      message: "用户拒绝执行此修改操作。",
    },
  };
}

export class AgentRunner {
  constructor({ api, executeTool, requestApproval, captureToolPreview, onEvent = () => {} } = {}) {
    if (!api || typeof api.start !== "function") {
      throw new TypeError("AgentRunner 需要本地 API 客户端。" );
    }
    if (typeof executeTool !== "function" || typeof requestApproval !== "function") {
      throw new TypeError("AgentRunner 需要工具执行器和批准处理器。" );
    }
    this.api = api;
    this.executeTool = executeTool;
    this.requestApproval = requestApproval;
    this.captureToolPreview = typeof captureToolPreview === "function"
      ? captureToolPreview
      : async () => null;
    this.onEvent = onEvent;
    this.sessionId = null;
    this.running = false;
    this.controller = null;
  }

  restoreSession(sessionId) {
    if (this.running) {
      throw new AgentRunnerError("RUN_ALREADY_ACTIVE", "当前任务尚未完成。" );
    }
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new TypeError("恢复会话需要有效的会话 ID。" );
    }
    this.sessionId = sessionId.trim();
  }

  discardSession(sessionId = this.sessionId) {
    if (!sessionId || this.sessionId !== sessionId) return false;
    this.controller?.abort();
    this.sessionId = null;
    return true;
  }

  async capturePreview(details) {
    try {
      return await this.captureToolPreview(details);
    } catch {
      return null;
    }
  }

  async run(message, options = {}) {
    if (this.running) {
      throw new AgentRunnerError("RUN_ALREADY_ACTIVE", "当前任务尚未完成。" );
    }

    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const streamEvent = (event) => {
      if (event?.type === "text_delta" && typeof event.text === "string") {
        this.onEvent({ type: "assistant_delta", text: event.text });
        return;
      }
      this.onEvent(event);
    };
    const isNewSession = this.sessionId === null;
    if (isNewSession) {
      this.sessionId = makeSessionId();
    }
    this.onEvent({ type: "run_started", message, attachments: options.attachments ?? [] });

    try {
      let response = isNewSession
        ? await this.api.start({ sessionId: this.sessionId, message, signal, ...options, onEvent: streamEvent })
        : await this.api.addMessage({ sessionId: this.sessionId, message, signal, ...options, onEvent: streamEvent });

      if (response.context) {
        this.onEvent({ type: "context_updated", context: response.context });
      }

      while (response.status === "requires_action") {
        signal.throwIfAborted();
        if (!Array.isArray(response.toolCalls) || response.toolCalls.length === 0) {
          throw new AgentRunnerError(
            "TOOL_CALLS_MISSING",
            "服务要求执行工具，但没有返回工具调用。",
          );
        }

        const results = [];
        for (const call of response.toolCalls) {
          signal.throwIfAborted();
          const tool = getToolDefinition(call.name);
          if (!tool) {
            throw new AgentRunnerError("TOOL_UNKNOWN", `任务窗格不认识工具：${call.name}`);
          }
          const args = parseAndValidateToolArguments(call.name, call.arguments);
          this.onEvent({ type: "tool_pending", call, tool, arguments: args });

          let output;
          if (tool.mode === "modify") {
            const approved = await this.requestApproval(
              { ...call, label: tool.label, mode: tool.mode, arguments: args },
              { signal },
            );
            signal.throwIfAborted();
            if (!approved) {
              output = cancelledResult();
              const preview = await this.capturePreview({ call, tool, arguments: args, output });
              this.onEvent({ type: "tool_denied", call, tool, arguments: args, output, preview });
            }
          }

          if (output === undefined) {
            this.onEvent({ type: "tool_running", call, tool, arguments: args });
            output = await this.executeTool(call.name, args);
            signal.throwIfAborted();
            const preview = await this.capturePreview({ call, tool, arguments: args, output });
            this.onEvent({
              type: "tool_completed",
              call,
              tool,
              arguments: args,
              output,
              preview,
            });
          }

          results.push({ callId: call.callId, name: call.name, output });
        }

        response = await this.api.submitToolResults({
          sessionId: this.sessionId,
          results,
          signal,
          onEvent: streamEvent,
        });
        if (response.context) {
          this.onEvent({ type: "context_updated", context: response.context });
        }
      }

      if (response.status !== "completed") {
        throw new AgentRunnerError("AGENT_STATUS_INVALID", "服务返回了未知 Agent 状态。" );
      }
      signal.throwIfAborted();
      this.onEvent({ type: "assistant_message", message: response.message ?? "" });
      return response;
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        this.onEvent({ type: "run_stopped" });
        return { status: "stopped" };
      }
      const recoverableSession = error?.recoverableSession === true;
      if (!recoverableSession) {
        this.sessionId = null;
      }
      this.onEvent({ type: "run_error", error, recoverableSession });
      throw error;
    } finally {
      this.running = false;
      this.controller = null;
      this.onEvent({ type: "run_finished" });
    }
  }

  async stop({ throwOnCancelFailure = false } = {}) {
    if (!this.running) {
      return true;
    }
    const sessionId = this.sessionId;
    this.controller?.abort();
    if (sessionId) {
      try {
        await this.api.cancel({ sessionId });
      } catch (error) {
        if (throwOnCancelFailure) throw error;
        return false;
      }
      this.discardSession(sessionId);
    }
    return true;
  }

  async resetSession() {
    if (this.running) {
      await this.stop({ throwOnCancelFailure: true });
      return;
    }
    const sessionId = this.sessionId;
    if (sessionId) {
      await this.api.cancel({ sessionId });
      this.discardSession(sessionId);
    }
  }
}
