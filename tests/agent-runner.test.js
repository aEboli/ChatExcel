import assert from "node:assert/strict";
import test from "node:test";
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
