import assert from "node:assert/strict";
import test from "node:test";
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

test("拒绝未知工具并清理会话", async (t) => {
  const manager = new SessionManager({
    responsesClient: {
      async create() {
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

  await assert.rejects(
    () => manager.start("test", "session-unknown-01"),
    (error) => error instanceof AgentSessionError && error.code === "TOOL_UNKNOWN",
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
