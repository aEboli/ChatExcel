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
  constructor({ api, executeTool, requestApproval, onEvent = () => {} } = {}) {
    if (!api || typeof api.start !== "function") {
      throw new TypeError("AgentRunner 需要本地 API 客户端。" );
    }
    if (typeof executeTool !== "function" || typeof requestApproval !== "function") {
      throw new TypeError("AgentRunner 需要工具执行器和批准处理器。" );
    }
    this.api = api;
    this.executeTool = executeTool;
    this.requestApproval = requestApproval;
    this.onEvent = onEvent;
    this.sessionId = null;
    this.running = false;
    this.controller = null;
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
              this.onEvent({ type: "tool_denied", call, tool, arguments: args, output });
            }
          }

          if (output === undefined) {
            this.onEvent({ type: "tool_running", call, tool, arguments: args });
            output = await this.executeTool(call.name, args);
            signal.throwIfAborted();
            this.onEvent({
              type: "tool_completed",
              call,
              tool,
              arguments: args,
              output,
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
      this.sessionId = null;
      this.onEvent({ type: "run_error", error });
      throw error;
    } finally {
      this.running = false;
      this.controller = null;
      this.onEvent({ type: "run_finished" });
    }
  }

  async stop() {
    if (!this.running) {
      return;
    }
    const sessionId = this.sessionId;
    this.controller?.abort();
    this.sessionId = null;
    if (sessionId) {
      try {
        await this.api.cancel({ sessionId });
      } catch {
        // The local request is already stopped; a missing server session is harmless here.
      }
    }
  }

  async resetSession() {
    if (this.running) {
      await this.stop();
      return;
    }
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId) {
      try {
        await this.api.cancel({ sessionId });
      } catch {
        // A stale or expired in-memory session needs no further cleanup.
      }
    }
  }
}
