import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationRecoveryStore } from "../src/server/conversation-recovery-store.js";
import { AgentSessionError, SessionManager } from "../src/server/session-manager.js";

function finalResponse(text = "完成") {
  return {
    id: "resp_final",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

async function createRecoveryStore(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chatexcel-session-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new ConversationRecoveryStore({
    recoveryPath: join(directory, "conversation-recovery.json"),
    protect: async (plaintext) => Buffer.from(plaintext, "utf8").toString("base64"),
    unprotect: async (ciphertext) => Buffer.from(ciphertext, "base64").toString("utf8"),
    ...options,
  });
}

test("保留完整 output 并按 call_id 续传工具结果", async (t) => {
  const inputs = [];
  const responses = [
    {
      id: "resp_tool",
      output: [
        { type: "reasoning", id: "reason_1", summary: [] },
        {
          type: "function_call",
          name: "read_range",
          call_id: "call_1",
          arguments: JSON.stringify({ worksheet: null, address: "A1:B2" }),
        },
      ],
    },
    finalResponse("读取完成"),
  ];
  const manager = new SessionManager({
    responsesClient: {
      async create({ input }) {
        inputs.push(structuredClone(input));
        return responses.shift();
      },
    },
  });
  t.after(() => manager.dispose());

  const first = await manager.start("读取数据", "session-normal-01");
  assert.equal(first.status, "requires_action");
  assert.equal(first.toolCalls[0].name, "read_range");

  const second = await manager.submitToolResults(first.sessionId, [
    {
      callId: "call_1",
      name: "read_range",
      output: { ok: true, values: [[1, 2], [3, 4]] },
    },
  ]);

  assert.equal(second.status, "completed");
  assert.equal(second.message, "读取完成");
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1][1].type, "reasoning");
  assert.equal(inputs[1][2].type, "function_call");
  assert.deepEqual(inputs[1][3], {
    type: "function_call_output",
    call_id: "call_1",
    output: JSON.stringify({ ok: true, values: [[1, 2], [3, 4]] }),
  });
});

test("默认模型步骤上限为 100", (t) => {
  const manager = new SessionManager({
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => manager.dispose());
  assert.equal(manager.maxSteps, 100);
});

test("未知工具作为可恢复结果反馈模型并自动继续", async (t) => {
  const inputs = [];
  const events = [];
  let requestCount = 0;
  const manager = new SessionManager({
    responsesClient: {
      async create({ input, onEvent }) {
        inputs.push(structuredClone(input));
        requestCount += 1;
        if (requestCount > 1) {
          onEvent?.({ type: "text_delta", text: "第二步" });
          return finalResponse("已改用可用工具完成检查");
        }
        onEvent?.({ type: "text_delta", text: "第一步" });
        return {
          output: [
            {
              type: "function_call",
              name: "dangerous_unknown_tool",
              call_id: "call_unknown",
              arguments: "{}",
            },
          ],
        };
      },
    },
  });
  t.after(() => manager.dispose());

  const result = await manager.start("test", "session-unknown-01", {}, {
    onEvent(event) {
      events.push(event);
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.message, "已改用可用工具完成检查");
  assert.equal(requestCount, 2);
  assert.equal(manager.sessions.size, 1);
  assert.deepEqual(events, [
    { type: "text_delta", text: "第一步" },
    { type: "model_step_boundary" },
    { type: "text_delta", text: "第二步" },
  ]);
  const recovery = inputs[1].find((item) => item.type === "function_call_output");
  assert.equal(recovery.call_id, "call_unknown");
  assert.deepEqual(JSON.parse(recovery.output), {
    ok: false,
    error: {
      code: "TOOL_UNKNOWN",
      message: "模型请求了未知 Excel 工具。请从已提供的工具列表中选择并重试。",
      path: "$.name",
      recoverable: true,
    },
  });
});

test("无效地址反馈模型后自动接受修正调用", async (t) => {
  const inputs = [];
  const responses = [
    {
      output: [{
        type: "function_call",
        name: "autofit_range",
        call_id: "call_invalid_range",
        arguments: JSON.stringify({ worksheet: null, address: "N through R", columns: true, rows: false }),
      }],
    },
    {
      output: [{
        type: "function_call",
        name: "autofit_range",
        call_id: "call_corrected_range",
        arguments: JSON.stringify({ worksheet: null, address: "N:R", columns: true, rows: false }),
      }],
    },
    finalResponse("列宽已调整"),
  ];
  const manager = new SessionManager({
    responsesClient: {
      async create({ input }) {
        inputs.push(structuredClone(input));
        return responses.shift();
      },
    },
  });
  t.after(() => manager.dispose());

  const first = await manager.start("调整 N 到 R 列", "session-recover-range");
  assert.equal(first.status, "requires_action");
  assert.equal(first.step, 2);
  assert.equal(first.toolCalls[0].callId, "call_corrected_range");
  assert.equal(first.toolCalls[0].arguments.address, "N:R");
  const recovery = inputs[1].find((item) => item.type === "function_call_output");
  assert.equal(JSON.parse(recovery.output).error.code, "RANGE_ADDRESS_INVALID");
  assert.equal(JSON.parse(recovery.output).error.path, "$.address");

  const final = await manager.submitToolResults(first.sessionId, [{
    callId: "call_corrected_range",
    name: "autofit_range",
    output: { ok: true, target: "Sheet1!N:R" },
  }]);
  assert.equal(final.status, "completed");
  assert.equal(final.message, "列宽已调整");
});

test("同一步只交付有效调用并在下一步合并全部工具结果", async (t) => {
  const inputs = [];
  const responses = [
    {
      output: [
        {
          type: "function_call",
          name: "get_selection",
          call_id: "call_valid",
          arguments: "{}",
        },
        {
          type: "function_call",
          name: "read_range",
          call_id: "call_invalid",
          arguments: JSON.stringify({ worksheet: null, address: "Sheet1!A1" }),
        },
      ],
    },
    finalResponse("已根据有效选区继续"),
  ];
  const manager = new SessionManager({
    responsesClient: {
      async create({ input }) {
        inputs.push(structuredClone(input));
        return responses.shift();
      },
    },
  });
  t.after(() => manager.dispose());

  const first = await manager.start("检查当前选区", "session-mixed-calls");
  assert.equal(first.status, "requires_action");
  assert.deepEqual(first.toolCalls.map((call) => call.callId), ["call_valid"]);
  assert.equal(inputs.length, 1);

  const final = await manager.submitToolResults(first.sessionId, [{
    callId: "call_valid",
    name: "get_selection",
    output: { ok: true, address: "A1:B2" },
  }]);

  assert.equal(final.status, "completed");
  assert.equal(final.message, "已根据有效选区继续");
  const toolOutputs = inputs[1].filter((item) => item.type === "function_call_output");
  assert.deepEqual(toolOutputs.map((item) => item.call_id), ["call_invalid", "call_valid"]);
  assert.equal(JSON.parse(toolOutputs[0].output).error.code, "RANGE_ADDRESS_INVALID");
  assert.deepEqual(JSON.parse(toolOutputs[1].output), { ok: true, address: "A1:B2" });
});

test("缺失 call_id 仍终止并清理会话", async (t) => {
  const manager = new SessionManager({
    responsesClient: {
      async create() {
        return {
          output: [{ type: "function_call", name: "get_selection", arguments: "{}" }],
        };
      },
    },
  });
  t.after(() => manager.dispose());

  await assert.rejects(
    () => manager.start("test", "session-missing-call-id"),
    (error) => error instanceof AgentSessionError && error.code === "TOOL_CALL_ID_MISSING",
  );
  assert.equal(manager.sessions.size, 0);
});

test("重复 call_id 仍终止并清理会话", async (t) => {
  const manager = new SessionManager({
    responsesClient: {
      async create() {
        return {
          output: [
            { type: "function_call", name: "get_selection", call_id: "call_same", arguments: "{}" },
            { type: "function_call", name: "get_workbook_info", call_id: "call_same", arguments: "{}" },
          ],
        };
      },
    },
  });
  t.after(() => manager.dispose());

  await assert.rejects(
    () => manager.start("test", "session-duplicate-call-id"),
    (error) => error instanceof AgentSessionError && error.code === "TOOL_CALL_ID_DUPLICATE",
  );
  assert.equal(manager.sessions.size, 0);
});

test("拒绝不匹配的工具结果且不发起下一步", async (t) => {
  let requestCount = 0;
  const manager = new SessionManager({
    responsesClient: {
      async create() {
        requestCount += 1;
        return {
          output: [
            {
              type: "function_call",
              name: "get_selection",
              call_id: "call_expected",
              arguments: "{}",
            },
          ],
        };
      },
    },
  });
  t.after(() => manager.dispose());
  await manager.start("test", "session-mismatch-01");

  await assert.rejects(
    () =>
      manager.submitToolResults("session-mismatch-01", [
        { callId: "call_other", name: "get_selection", output: { ok: true } },
      ]),
    (error) => error instanceof AgentSessionError && error.code === "TOOL_RESULT_MISMATCH",
  );
  assert.equal(requestCount, 1);
  assert.equal(manager.sessions.size, 0);
});

test("重复可恢复错误达到步骤上限后终止并清理会话", async (t) => {
  let requestCount = 0;
  const manager = new SessionManager({
    maxSteps: 2,
    responsesClient: {
      async create() {
        requestCount += 1;
        return {
          output: [{
            type: "function_call",
            name: "read_range",
            call_id: `call_invalid_${requestCount}`,
            arguments: JSON.stringify({ worksheet: null, address: "N through R" }),
          }],
        };
      },
    },
  });
  t.after(() => manager.dispose());

  await assert.rejects(
    () => manager.start("test", "session-recovery-limit"),
    (error) =>
      error instanceof AgentSessionError
      && error.code === "STEP_LIMIT_EXCEEDED"
      && error.message.includes("2 个模型步骤上限"),
  );
  assert.equal(requestCount, 2);
  assert.equal(manager.sessions.size, 0);
});

test("模型持续调用工具时执行步骤上限", async (t) => {
  let index = 0;
  const manager = new SessionManager({
    maxSteps: 2,
    responsesClient: {
      async create() {
        index += 1;
        return {
          output: [
            {
              type: "function_call",
              name: "get_workbook_info",
              call_id: `call_${index}`,
              arguments: "{}",
            },
          ],
        };
      },
    },
  });
  t.after(() => manager.dispose());
  const first = await manager.start("test", "session-limit-01");

  await assert.rejects(
    () =>
      manager.submitToolResults(first.sessionId, [
        { callId: "call_1", name: "get_workbook_info", output: { ok: true } },
      ]),
    (error) =>
      error instanceof AgentSessionError
      && error.code === "STEP_LIMIT_EXCEEDED"
      && error.message.includes("2 个模型步骤上限"),
  );
  assert.equal(manager.sessions.size, 0);
});

test("取消会中止正在进行的模型请求并清理会话", async (t) => {
  let aborted = false;
  const manager = new SessionManager({
    responsesClient: {
      create({ signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new AgentSessionError("AGENT_CANCELLED", "cancelled", 499));
            },
            { once: true },
          );
        });
      },
    },
  });
  t.after(() => manager.dispose());
  const startPromise = manager.start("test", "session-cancel-01");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await manager.cancel("session-cancel-01"), true);
  await assert.rejects(() => startPromise, (error) => error.code === "AGENT_CANCELLED");
  assert.equal(aborted, true);
  assert.equal(manager.sessions.size, 0);
});

test("显式取消后迟到的模型响应不能重新写入恢复缓存", async (t) => {
  const recoveryStore = await createRecoveryStore(t);
  let resolveResponse;
  let requestStarted;
  const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
  const manager = new SessionManager({
    recoveryStore,
    responsesClient: {
      create() {
        return new Promise((resolve) => {
          resolveResponse = resolve;
          requestStarted();
        });
      },
    },
  });
  t.after(() => manager.dispose());

  const startPromise = manager.start("删除临时数据", "session-cancel-race-01", {
    workbookBinding: "workbook://cancel-race",
  });
  await requestStartedPromise;
  assert.equal(await manager.cancel("session-cancel-race-01"), true);

  resolveResponse(finalResponse("不应在取消后写入"));
  await assert.rejects(() => startPromise, (error) => error.code === "AGENT_CANCELLED");

  assert.equal(manager.sessions.size, 0);
  assert.equal((await recoveryStore.restore({ workbookKey: "workbook://cancel-race" })).status, "missing");
});

test("清理超过空闲期限的内存会话", async (t) => {
  let currentTime = 1_000;
  const manager = new SessionManager({
    idleTtlMs: 100,
    now: () => currentTime,
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => manager.dispose());
  await manager.start("test", "session-expire-01");
  assert.equal(manager.sessions.size, 1);

  currentTime = 1_101;
  manager.cleanupExpired();
  assert.equal(manager.sessions.size, 0);
});

test("恢复会话由任务窗格心跳租约保留，而不是用户消息空闲时间", async (t) => {
  let currentTime = 1_000;
  const recoveryStore = await createRecoveryStore(t, {
    now: () => currentTime,
    ttlMs: 100,
  });
  const manager = new SessionManager({
    recoveryStore,
    idleTtlMs: 100,
    now: () => currentTime,
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => manager.dispose());

  await manager.start("保持恢复会话", "session-pane-lease-alive", {
    workbookBinding: "workbook://pane-lease-alive",
  });
  const session = manager.sessions.get("session-pane-lease-alive");
  assert.equal(session.lastTouched, 1_000);
  assert.equal(session.lastPaneHeartbeatAt, 1_000);

  currentTime = 1_050;
  assert.deepEqual(
    await manager.touchRecovery("session-pane-lease-alive", "workbook://pane-lease-alive"),
    { status: "touched" },
  );
  assert.equal(session.lastTouched, 1_000);
  assert.equal(session.lastPaneHeartbeatAt, 1_050);

  currentTime = 1_101;
  manager.cleanupExpired();
  assert.equal(manager.sessions.has("session-pane-lease-alive"), true);
});

test("恢复会话在最后一次任务窗格心跳超过期限后清理", async (t) => {
  let currentTime = 1_000;
  const recoveryStore = await createRecoveryStore(t, {
    now: () => currentTime,
    ttlMs: 100,
  });
  const manager = new SessionManager({
    recoveryStore,
    idleTtlMs: 100,
    now: () => currentTime,
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => manager.dispose());

  await manager.start("保持恢复会话", "session-pane-lease-expire", {
    workbookBinding: "workbook://pane-lease-expire",
  });
  currentTime = 1_050;
  assert.deepEqual(
    await manager.touchRecovery("session-pane-lease-expire", "workbook://pane-lease-expire"),
    { status: "touched" },
  );

  currentTime = 1_151;
  manager.cleanupExpired();
  assert.equal(manager.sessions.has("session-pane-lease-expire"), false);
});

test("失败的恢复心跳不会延长内存窗格租约", async (t) => {
  let currentTime = 1_000;
  let failNextSave = false;
  const recoveryStore = {
    async save() {
      if (failNextSave) throw new Error("disk unavailable");
      return { status: "saved" };
    },
    async restore() { return { status: "missing" }; },
    async clear() { return { status: "missing" }; },
    async touch() { return { status: "missing" }; },
  };
  const manager = new SessionManager({
    recoveryStore,
    idleTtlMs: 100,
    now: () => currentTime,
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => manager.dispose());

  await manager.start("保持恢复会话", "session-pane-lease-failure", {
    workbookBinding: "workbook://pane-lease-failure",
  });
  const session = manager.sessions.get("session-pane-lease-failure");

  currentTime = 1_050;
  failNextSave = true;
  assert.deepEqual(
    await manager.touchRecovery("session-pane-lease-failure", "workbook://pane-lease-failure"),
    { status: "unavailable" },
  );
  assert.equal(session.lastPaneHeartbeatAt, 1_000);

  currentTime = 1_101;
  manager.cleanupExpired();
  assert.equal(manager.sessions.has("session-pane-lease-failure"), false);
});

test("图片、模型选项和上下文占用沿会话传递", async (t) => {
  let captured;
  const manager = new SessionManager({
    responsesClient: {
      async create(request) {
        captured = structuredClone({ input: request.input, options: request.options });
        return {
          ...finalResponse("图片已分析"),
          usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 },
          __chatExcel: { model: "gpt-5-test", contextWindow: 10000 },
        };
      },
    },
  });
  t.after(() => manager.dispose());
  const dataUrl = `data:image/png;base64,${Buffer.from("small-image").toString("base64")}`;

  const result = await manager.start("分析标注", "session-image-01", {
    attachments: [{ name: "标注.png", dataUrl }],
    model: "gpt-5-test",
    reasoningEffort: "high",
  });

  assert.deepEqual(captured.options, { model: "gpt-5-test", reasoningEffort: "high" });
  assert.deepEqual(captured.input[0].content, [
    { type: "input_text", text: "分析标注" },
    { type: "input_image", image_url: dataUrl },
  ]);
  assert.deepEqual(result.context, {
    status: "available",
    usedTokens: 1000,
    limitTokens: 10000,
    percent: 10,
    model: "gpt-5-test",
  });
});

test("拒绝过多或不支持格式的图片", async (t) => {
  const manager = new SessionManager({ responsesClient: { async create() { return finalResponse(); } } });
  t.after(() => manager.dispose());
  const valid = { dataUrl: "data:image/png;base64,YQ==" };

  await assert.rejects(
    () => manager.start("test", "session-images-many", { attachments: Array(5).fill(valid) }),
    (error) => error.code === "ATTACHMENTS_TOO_MANY",
  );
  await assert.rejects(
    () => manager.start("test", "session-image-gif", {
      attachments: [{ dataUrl: "data:image/gif;base64,YQ==" }],
    }),
    (error) => error.code === "ATTACHMENT_TYPE_UNSUPPORTED",
  );
});

test("服务重启后恢复当前会话且恢复本身不调用模型", async (t) => {
  const recoveryStore = await createRecoveryStore(t);
  const firstManager = new SessionManager({
    recoveryStore,
    responsesClient: { async create() { return finalResponse("首次分析完成"); } },
  });
  t.after(() => firstManager.dispose());

  const started = await firstManager.start("分析 Sheet1!A1", "session-restore-01", {
    workbookBinding: "workbook://sales-report",
  });
  assert.equal(started.status, "completed");
  firstManager.dispose();

  let providerCalls = 0;
  let continuedInput;
  const restoredManager = new SessionManager({
    recoveryStore,
    responsesClient: {
      async create({ input }) {
        providerCalls += 1;
        continuedInput = structuredClone(input);
        return finalResponse("已按你的明确请求继续");
      },
    },
  });
  t.after(() => restoredManager.dispose());

  const recovered = await restoredManager.restore("workbook://sales-report");

  assert.equal(recovered.sessionId, "session-restore-01");
  assert.deepEqual(recovered.presentation.messages, [
    { role: "user", text: "分析 Sheet1!A1" },
    { role: "assistant", text: "首次分析完成" },
  ]);
  assert.equal(providerCalls, 0);

  await restoredManager.addMessage(recovered.sessionId, "请继续", {});
  assert.equal(providerCalls, 1);
  assert.equal(continuedInput[0].content[0].text, "分析 Sheet1!A1");
  assert.equal(continuedInput.at(-1).content[0].text, "请继续");
});

test("正常服务关闭会挂起进行中的请求并保留恢复快照", async (t) => {
  const recoveryStore = await createRecoveryStore(t);
  let requestStarted;
  const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
  const manager = new SessionManager({
    recoveryStore,
    responsesClient: {
      create({ signal }) {
        requestStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new AgentSessionError("AGENT_CANCELLED", "服务正在关闭", 499)),
            { once: true },
          );
        });
      },
    },
  });
  t.after(() => manager.dispose());

  const startPromise = manager.start("继续未完成任务", "session-shutdown-recovery-01", {
    workbookBinding: "workbook://shutdown-recovery",
  });
  await requestStartedPromise;
  await manager.dispose();
  await assert.rejects(() => startPromise, (error) => error.code === "AGENT_CANCELLED");

  assert.equal(manager.sessions.size, 0);
  assert.equal(
    (await recoveryStore.restore({ workbookKey: "workbook://shutdown-recovery" })).status,
    "available",
  );
});

test("恢复缓存失效时只报告状态，不建立会话或调用模型", async (t) => {
  const recoveryStore = {
    async save() { return { status: "saved" }; },
    async restore() { return { status: "unavailable" }; },
    async clear() { return { status: "missing" }; },
    async touch() { return { status: "missing" }; },
  };
  let providerCalls = 0;
  const manager = new SessionManager({
    recoveryStore,
    responsesClient: {
      async create() {
        providerCalls += 1;
        return finalResponse();
      },
    },
  });
  t.after(() => manager.dispose());

  const recovered = await manager.restore("workbook://unavailable");

  assert.deepEqual(recovered, { recovery: { status: "unavailable" } });
  assert.equal(manager.sessions.size, 0);
  assert.equal(providerCalls, 0);
});

test("恢复心跳保留不可用状态，避免把存储故障伪装为记录缺失", async (t) => {
  const touchCalls = [];
  const recoveryStore = {
    async save() { return { status: "saved" }; },
    async restore() { return { status: "missing" }; },
    async clear() { return { status: "missing" }; },
    async touch(input) {
      touchCalls.push(input);
      return { status: "unavailable" };
    },
  };
  const manager = new SessionManager({
    recoveryStore,
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => manager.dispose());

  const touched = await manager.touchRecovery("session-heartbeat-01", "workbook://heartbeat");

  assert.deepEqual(touched, { status: "unavailable" });
  assert.deepEqual(touchCalls, [{
    sessionId: "session-heartbeat-01",
    workbookKey: "workbook://heartbeat",
  }]);
});

test("最终提供方失败后保留会话，下一条显式消息才能继续", async (t) => {
  const recoveryStore = await createRecoveryStore(t);
  let attempts = 0;
  const inputs = [];
  const manager = new SessionManager({
    recoveryStore,
    responsesClient: {
      async create({ input }) {
        attempts += 1;
        inputs.push(structuredClone(input));
        if (attempts === 1) {
          const error = new Error("provider unavailable");
          error.code = "PROVIDER_UNAVAILABLE";
          throw error;
        }
        return finalResponse("已在你明确继续后完成");
      },
    },
  });
  t.after(() => manager.dispose());

  await assert.rejects(
    () => manager.start("检查库存", "session-provider-recovery", {
      workbookBinding: "workbook://inventory",
    }),
    (error) => error?.recoverableSession === true,
  );
  assert.equal(manager.sessions.has("session-provider-recovery"), true);
  assert.equal((await recoveryStore.restore({ workbookKey: "workbook://inventory" })).status, "available");

  await manager.addMessage("session-provider-recovery", "请继续", {});
  assert.equal(attempts, 2);
  assert.equal(inputs[1].at(-1).content[0].text, "请继续");
});

test("恢复等待工具的会话时只写入中断结果，不自动调用模型或工具", async (t) => {
  const recoveryStore = await createRecoveryStore(t);
  const firstManager = new SessionManager({
    recoveryStore,
    responsesClient: {
      async create() {
        return {
          output: [{
            type: "function_call",
            name: "write_values",
            call_id: "write-pending-1",
            arguments: JSON.stringify({ worksheet: null, address: "A1", values: [[42]] }),
          }],
        };
      },
    },
  });
  t.after(() => firstManager.dispose());

  const pending = await firstManager.start("写入 42", "session-tool-recovery", {
    workbookBinding: "workbook://pending-tool",
  });
  assert.equal(pending.status, "requires_action");
  firstManager.dispose();

  let providerCalls = 0;
  let continuedInput;
  const restoredManager = new SessionManager({
    recoveryStore,
    responsesClient: {
      async create({ input }) {
        providerCalls += 1;
        continuedInput = structuredClone(input);
        return finalResponse("已重新检查工作簿");
      },
    },
  });
  t.after(() => restoredManager.dispose());

  const recovered = await restoredManager.restore("workbook://pending-tool");

  assert.equal(recovered.recovery.notice, "tool_execution_interrupted");
  assert.equal(providerCalls, 0);
  await restoredManager.addMessage(recovered.sessionId, "请重新检查后继续", {});
  assert.equal(providerCalls, 1);
  const interruptedOutput = continuedInput.find((item) => item.type === "function_call_output");
  assert.equal(JSON.parse(interruptedOutput.output).error.code, "TOOL_EXECUTION_INTERRUPTED");
});

test("异常断开挂起会话并保存请求前上下文，显式取消会删除恢复快照", async (t) => {
  const recoveryStore = await createRecoveryStore(t);
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const manager = new SessionManager({
    recoveryStore,
    responsesClient: {
      create({ signal }) {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.code = "AGENT_CANCELLED";
            reject(error);
          }, { once: true });
        });
      },
    },
  });
  t.after(() => manager.dispose());

  const startPromise = manager.start("处理中", "session-suspend-01", {
    workbookBinding: "workbook://suspend",
  });
  await requestStarted;
  assert.equal(await manager.suspend("session-suspend-01"), true);
  await assert.rejects(() => startPromise, (error) => error?.code === "AGENT_CANCELLED");
  assert.equal(manager.sessions.has("session-suspend-01"), false);

  const afterSuspend = await recoveryStore.restore({ workbookKey: "workbook://suspend" });
  assert.equal(afterSuspend.status, "available");

  const restoredManager = new SessionManager({
    recoveryStore,
    responsesClient: { async create() { return finalResponse(); } },
  });
  t.after(() => restoredManager.dispose());
  const recovered = await restoredManager.restore("workbook://suspend");
  assert.equal(recovered.recovery.notice, "model_request_interrupted");
  await restoredManager.cancel(recovered.sessionId);
  assert.equal((await recoveryStore.restore({ workbookKey: "workbook://suspend" })).status, "missing");
});
