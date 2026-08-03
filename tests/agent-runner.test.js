import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../src/server/session-manager.js";
import { AgentRunner } from "../src/taskpane/agent-runner.js";

test("读取工具自动执行，拒绝的修改工具不会调用执行器", async () => {
  const executed = [];
  let submitted;
  const runner = new AgentRunner({
    api: {
      async start() {
        return {
          status: "requires_action",
          toolCalls: [
            { callId: "read_1", name: "get_workbook_info", arguments: {} },
            {
              callId: "write_1",
              name: "write_values",
              arguments: { worksheet: null, address: "A1", values: [[1]] },
            },
          ],
        };
      },
      async submitToolResults({ results }) {
        submitted = results;
        return { status: "completed", message: "完成" };
      },
      async cancel() {},
    },
    async executeTool(name) {
      executed.push(name);
      return { ok: true };
    },
    async requestApproval() {
      return false;
    },
  });

  const result = await runner.run("test");

  assert.equal(result.status, "completed");
  assert.deepEqual(executed, ["get_workbook_info"]);
  assert.equal(submitted[0].output.ok, true);
  assert.equal(submitted[1].output.error.code, "USER_DENIED");
});

test("批准的修改工具只执行一次", async () => {
  let executionCount = 0;
  const runner = new AgentRunner({
    api: {
      async start() {
        return {
          status: "requires_action",
          toolCalls: [
            {
              callId: "write_1",
              name: "write_values",
              arguments: { worksheet: null, address: "A1", values: [[1]] },
            },
          ],
        };
      },
      async submitToolResults() {
        return { status: "completed", message: "完成" };
      },
      async cancel() {},
    },
    async executeTool() {
      executionCount += 1;
      return { ok: true };
    },
    async requestApproval() {
      return true;
    },
  });

  await runner.run("test");
  assert.equal(executionCount, 1);
});

test("步骤预览在工具执行后捕获，且不会进入提交给模型的工具结果", async () => {
  const sequence = [];
  const events = [];
  let submitted;
  const runner = new AgentRunner({
    api: {
      async start() {
        return {
          status: "requires_action",
          toolCalls: [{
            callId: "read_1",
            name: "read_range",
            arguments: { worksheet: "Sheet1", address: "A1" },
          }],
        };
      },
      async submitToolResults({ results }) {
        submitted = results;
        return { status: "completed", message: "完成" };
      },
      async cancel() {},
    },
    async executeTool() {
      sequence.push("execute");
      return { ok: true, target: "Sheet1!A1", values: [[1]] };
    },
    async captureToolPreview() {
      sequence.push("capture");
      return { kind: "image", dataUrl: "data:image/png;base64,YQ==" };
    },
    async requestApproval() {
      return true;
    },
    onEvent(event) {
      events.push(event);
      if (event.type === "tool_completed") sequence.push("event");
    },
  });

  await runner.run("读取 A1");

  const completed = events.find((event) => event.type === "tool_completed");
  assert.deepEqual(sequence, ["execute", "capture", "event"]);
  assert.deepEqual(completed.preview, { kind: "image", dataUrl: "data:image/png;base64,YQ==" });
  assert.equal("preview" in submitted[0].output, false);
});

test("步骤预览捕获失败不会阻止工具结果继续提交", async () => {
  let submitted = false;
  const events = [];
  const runner = new AgentRunner({
    api: {
      async start() {
        return {
          status: "requires_action",
          toolCalls: [{
            callId: "read_1",
            name: "get_selection",
            arguments: {},
          }],
        };
      },
      async submitToolResults() {
        submitted = true;
        return { status: "completed", message: "完成" };
      },
      async cancel() {},
    },
    async executeTool() {
      return { ok: true };
    },
    async captureToolPreview() {
      throw new Error("预览不可用");
    },
    async requestApproval() {
      return true;
    },
    onEvent(event) {
      events.push(event);
    },
  });

  const result = await runner.run("读取选区");

  assert.equal(result.status, "completed");
  assert.equal(submitted, true);
  assert.equal(events.find((event) => event.type === "tool_completed")?.preview, null);
});

test("停止批准等待会取消服务会话且不执行工具", async () => {
  let executionCount = 0;
  let cancelledSessionId;
  let approvalStarted;
  const approvalReady = new Promise((resolve) => {
    approvalStarted = resolve;
  });
  const runner = new AgentRunner({
    api: {
      async start() {
        return {
          status: "requires_action",
          toolCalls: [
            {
              callId: "write_1",
              name: "write_values",
              arguments: { worksheet: null, address: "A1", values: [[1]] },
            },
          ],
        };
      },
      async submitToolResults() {
        throw new Error("不应提交工具结果");
      },
      async cancel({ sessionId }) {
        cancelledSessionId = sessionId;
      },
    },
    async executeTool() {
      executionCount += 1;
      return { ok: true };
    },
    requestApproval(_call, { signal }) {
      approvalStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("stopped", "AbortError")),
          { once: true },
        );
      });
    },
  });

  const runPromise = runner.run("test");
  await approvalReady;
  await runner.stop();
  const result = await runPromise;

  assert.equal(result.status, "stopped");
  assert.equal(executionCount, 0);
  assert.equal(typeof cancelledSessionId, "string");
});

test("把附件与模型选择传给 API 并发布上下文事件", async () => {
  let captured;
  const events = [];
  const runner = new AgentRunner({
    api: {
      async start(request) {
        captured = request;
        return {
          status: "completed",
          message: "完成",
          context: { status: "available", percent: 12 },
        };
      },
      async cancel() {},
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
    onEvent(event) { events.push(event); },
  });
  const attachments = [{ name: "标注.png", dataUrl: "data:image/png;base64,YQ==" }];

  await runner.run("分析", {
    attachments,
    model: "gpt-5-test",
    reasoningEffort: "low",
  });

  assert.equal(captured.model, "gpt-5-test");
  assert.equal(captured.reasoningEffort, "low");
  assert.deepEqual(captured.attachments, attachments);
  assert.equal(events.some((event) => event.type === "context_updated"), true);
});

test("把服务端文本增量转换为助手增量事件", async () => {
  const events = [];
  const runner = new AgentRunner({
    api: {
      async start({ onEvent }) {
        onEvent({ type: "text_delta", text: "流" });
        onEvent({ type: "text_delta", text: "式" });
        return { status: "completed", message: "流式" };
      },
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
    onEvent(event) { events.push(event); },
  });

  await runner.run("test");

  assert.deepEqual(
    events.filter((event) => event.type === "assistant_delta").map((event) => event.text),
    ["流", "式"],
  );
});

test("保留提供方重连和草稿重置事件", async () => {
  const events = [];
  const runner = new AgentRunner({
    api: {
      async start({ onEvent }) {
        onEvent({ type: "text_delta", text: "旧" });
        onEvent({ type: "stream_reset", discardTextLength: 1 });
        onEvent({ type: "provider_reconnecting", attempt: 1, maxAttempts: 10, delayMs: 3_000 });
        onEvent({ type: "text_delta", text: "新" });
        return { status: "completed", message: "新" };
      },
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
    onEvent(event) { events.push(event); },
  });

  await runner.run("test");

  assert.deepEqual(
    events.filter((event) => ["assistant_delta", "stream_reset", "provider_reconnecting"].includes(event.type)),
    [
      { type: "assistant_delta", text: "旧" },
      { type: "stream_reset", discardTextLength: 1 },
      { type: "provider_reconnecting", attempt: 1, maxAttempts: 10, delayMs: 3_000 },
      { type: "assistant_delta", text: "新" },
    ],
  );
});

test("保留服务端模型步骤边界事件", async () => {
  const events = [];
  const runner = new AgentRunner({
    api: {
      async start({ onEvent }) {
        onEvent({ type: "text_delta", text: "第一步" });
        onEvent({ type: "model_step_boundary" });
        onEvent({ type: "text_delta", text: "第二步" });
        return { status: "completed", message: "第二步" };
      },
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
    onEvent(event) { events.push(event); },
  });

  await runner.run("test");

  assert.deepEqual(
    events.filter((event) => ["assistant_delta", "model_step_boundary"].includes(event.type)),
    [
      { type: "assistant_delta", text: "第一步" },
      { type: "model_step_boundary" },
      { type: "assistant_delta", text: "第二步" },
    ],
  );
});

test("可恢复的服务错误保留会话并在下一次消息继续", async () => {
  const calls = [];
  const events = [];
  const recoverableError = new Error("提供方连接已中断。");
  recoverableError.recoverableSession = true;
  const runner = new AgentRunner({
    api: {
      async start({ sessionId }) {
        calls.push({ type: "start", sessionId });
        throw recoverableError;
      },
      async addMessage({ sessionId }) {
        calls.push({ type: "add_message", sessionId });
        return { status: "completed", message: "已继续。" };
      },
      async cancel() {},
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
    onEvent(event) { events.push(event); },
  });

  await assert.rejects(() => runner.run("第一次请求"), recoverableError);
  const recoveredSessionId = runner.sessionId;

  assert.equal(typeof recoveredSessionId, "string");
  assert.equal(events.at(-2)?.type, "run_error");
  assert.equal(events.at(-2)?.recoverableSession, true);

  await runner.run("明确继续");

  assert.deepEqual(calls.map((call) => call.type), ["start", "add_message"]);
  assert.equal(calls[0].sessionId, recoveredSessionId);
  assert.equal(calls[1].sessionId, recoveredSessionId);
});

test("恢复会话不会自动发起请求，重置会取消该会话", async () => {
  let started = 0;
  let continuedSessionId = null;
  let cancelledSessionId = null;
  const runner = new AgentRunner({
    api: {
      async start() {
        started += 1;
        return { status: "completed", message: "不应使用新会话" };
      },
      async addMessage({ sessionId }) {
        continuedSessionId = sessionId;
        return { status: "completed", message: "已继续。" };
      },
      async cancel({ sessionId }) {
        cancelledSessionId = sessionId;
      },
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
  });

  runner.restoreSession("recovered-session-01");
  assert.equal(started, 0);

  await runner.run("明确继续");
  assert.equal(started, 0);
  assert.equal(continuedSessionId, "recovered-session-01");

  await runner.resetSession();
  assert.equal(cancelledSessionId, "recovered-session-01");
  assert.equal(runner.sessionId, null);
});

test("重置请求失败时保留恢复会话 ID 以便重试", async () => {
  const cancelError = new Error("本地服务暂不可用");
  const runner = new AgentRunner({
    api: {
      async start() { return { status: "completed", message: "完成" }; },
      async cancel() { throw cancelError; },
    },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
  });

  runner.restoreSession("recovered-session-02");

  await assert.rejects(() => runner.resetSession(), cancelError);
  assert.equal(runner.sessionId, "recovered-session-02");
});

test("服务确认清除后可只丢弃匹配的本地会话", () => {
  const runner = new AgentRunner({
    api: { async start() { return { status: "completed", message: "完成" }; } },
    async executeTool() { return { ok: true }; },
    async requestApproval() { return true; },
  });

  runner.restoreSession("recovered-session-03");

  assert.equal(runner.discardSession("other-session"), false);
  assert.equal(runner.sessionId, "recovered-session-03");
  assert.equal(runner.discardSession("recovered-session-03"), true);
  assert.equal(runner.sessionId, null);
});

test("无效范围由模型自动修正且任务窗格不进入错误状态", async (t) => {
  const responses = [
    {
      output: [{
        type: "function_call",
        name: "autofit_range",
        call_id: "call_invalid",
        arguments: JSON.stringify({ worksheet: null, address: "N through R", columns: true, rows: false }),
      }],
    },
    {
      output: [{
        type: "function_call",
        name: "autofit_range",
        call_id: "call_corrected",
        arguments: JSON.stringify({ worksheet: null, address: "N:R", columns: true, rows: false }),
      }],
    },
    {
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "N 到 R 列已自动调整。" }],
      }],
    },
  ];
  const manager = new SessionManager({
    responsesClient: {
      async create() {
        return responses.shift();
      },
    },
  });
  t.after(() => manager.dispose());

  const api = {
    start({ sessionId, message, ...options }) {
      return manager.start(message, sessionId, options);
    },
    submitToolResults({ sessionId, results }) {
      return manager.submitToolResults(sessionId, results);
    },
    cancel({ sessionId }) {
      return manager.cancel(sessionId);
    },
  };
  const events = [];
  const executed = [];
  const runner = new AgentRunner({
    api,
    async executeTool(name, args) {
      executed.push({ name, args });
      return { ok: true, target: `Sheet1!${args.address}` };
    },
    async requestApproval() { return true; },
    onEvent(event) { events.push(event); },
  });

  const result = await runner.run("调整 N 到 R 列");

  assert.equal(result.status, "completed");
  assert.equal(result.message, "N 到 R 列已自动调整。");
  assert.deepEqual(executed, [{
    name: "autofit_range",
    args: { worksheet: null, address: "N:R", columns: true, rows: false },
  }]);
  assert.equal(events.some((event) => event.type === "run_error"), false);
  assert.equal(events.some((event) => event.type === "assistant_message"), true);
});
