import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "../src/server/provider-client.js";

function frame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function config(protocol, endpoint) {
  return {
    protocol,
    endpoint,
    model: protocol === "google-gemini" ? "gemini-2.5-flash" : "test-model",
    token: "provider-secret",
    reasoningEffort: "high",
    contextWindow: 32_000,
  };
}

const input = [{ role: "user", content: [{ type: "input_text", text: "你好" }] }];

function completedChatStream(text) {
  return [
    frame("message", { choices: [{ delta: { content: text } }] }),
    "event: message\ndata: [DONE]\n\n",
  ].join("");
}

function interruptedStream(chunk) {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      const error = new TypeError("socket reset");
      error.code = "ECONNRESET";
      controller.error(error);
    },
  });
}

test("四种协议都能把 SSE 文本增量归一化", async () => {
  const cases = [
    {
      protocol: "openai-responses",
      endpoint: "https://api.example/v1/responses",
      stream: [
        frame("response.output_text.delta", { delta: "你" }),
        frame("response.output_text.delta", { delta: "好" }),
        frame("response.completed", {
          response: {
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] }],
            usage: { total_tokens: 4 },
          },
        }),
      ].join(""),
      assertResponse(response) {
        assert.equal(response.output[0].content[0].text, "你好");
        assert.equal(response.usage.total_tokens, 4);
      },
    },
    {
      protocol: "openai-chat-completions",
      endpoint: "https://api.example/v1/chat/completions",
      stream: [
        frame("message", { choices: [{ delta: { content: "你" } }] }),
        frame("message", { choices: [{ delta: { content: "好" } }] }),
        frame("message", { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }),
        "event: message\ndata: [DONE]\n\n",
      ].join(""),
      assertResponse(response) {
        assert.equal(response.output[0].content[0].text, "你好");
        assert.equal(response.usage.total_tokens, 4);
      },
    },
    {
      protocol: "anthropic-messages",
      endpoint: "https://api.example/v1/messages",
      stream: [
        frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "你" } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好" } }),
        frame("message_delta", { usage: { input_tokens: 2, output_tokens: 2 } }),
        frame("message_stop", { type: "message_stop" }),
      ].join(""),
      assertResponse(response) {
        assert.equal(response.output[0].content[0].text, "你好");
        assert.equal(response.usage.total_tokens, 4);
      },
    },
    {
      protocol: "google-gemini",
      endpoint: "https://api.example/v1beta/models/gemini-2.5-flash:generateContent",
      stream: [
        frame("message", { candidates: [{ content: { parts: [{ text: "你" }] } }] }),
        frame("message", { candidates: [{ content: { parts: [{ text: "好" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } }),
      ].join(""),
      assertResponse(response) {
        assert.equal(response.output[0].content[0].text, "你好");
        assert.equal(response.usage.total_tokens, 4);
      },
    },
  ];

  for (const item of cases) {
    let captured;
    const deltas = [];
    const client = createProviderClient({
      configLoader: async () => config(item.protocol, item.endpoint),
      fetchImpl: async (url, options) => {
        captured = { url, body: JSON.parse(options.body), headers: options.headers };
        return new Response(item.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const response = await client.create({ input, onEvent: (event) => deltas.push(event) });
    assert.equal(captured.body.stream, item.protocol === "google-gemini" ? undefined : true);
    assert.equal(deltas.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "你好");
    if (item.protocol === "google-gemini") {
      assert.match(captured.url, /:streamGenerateContent\?alt=sse$/);
    }
    item.assertResponse(response);
  }
});

test("DeepSeek V4 Flash 流式 Chat Completions 保留官方思考控制", async () => {
  for (const effort of ["none", "low", "high", "max"]) {
    let captured;
    const client = createProviderClient({
      configLoader: async () => ({
        ...config("openai-chat-completions", "https://api.example/v1/chat/completions"),
        model: "deepseek-v4-flash",
        reasoningEffort: effort,
      }),
      fetchImpl: async (_url, options) => {
        captured = JSON.parse(options.body);
        return new Response(completedChatStream("完成"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    await client.create({ input, onEvent() {} });

    assert.equal(captured.stream, true);
    assert.deepEqual(captured.stream_options, { include_usage: true });
    assert.deepEqual(captured.thinking, { type: effort === "none" ? "disabled" : "enabled" });
    if (effort === "none") assert.equal(Object.hasOwn(captured, "reasoning_effort"), false);
    else assert.equal(captured.reasoning_effort, effort);
  }
});

test("流式工具参数完整后才归一化为调用", async () => {
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    fetchImpl: async () => new Response([
      frame("message", { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_range", arguments: "{\"address\":" } }] } }] }),
      frame("message", { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"A1\"}" } }] } }] }),
      "event: message\ndata: [DONE]\n\n",
    ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });

  const response = await client.create({ input, onEvent() {} });
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].arguments, "{\"address\":\"A1\"}");
});

test("Responses 增量参数按 item id 关联 call id", async () => {
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    fetchImpl: async () => new Response([
      frame("response.output_item.added", {
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_range", arguments: "" },
      }),
      frame("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"address\":" }),
      frame("response.function_call_arguments.delta", { item_id: "fc_1", delta: "\"A1\"}" }),
      frame("response.completed", {
        response: {
          output: [{
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read_range",
            arguments: "{\"address\":\"A1\"}",
          }],
        },
      }),
    ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });

  const response = await client.create({ input, onEvent() {} });
  assert.deepEqual(response.output, [{
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "read_range",
    arguments: "{\"address\":\"A1\"}",
  }]);
});

test("缺少协议终止标记的 SSE 会重连并撤销失败尝试文字", async () => {
  const events = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      const stream = requestCount === 1
        ? frame("message", { choices: [{ delta: { content: "旧" } }] })
        : completedChatStream("新");
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const response = await client.create({ input, onEvent: (event) => events.push(event) });

  assert.equal(requestCount, 2);
  assert.equal(response.output[0].content[0].text, "新");
  assert.deepEqual(events.map((event) => event.type), [
    "text_delta",
    "stream_reset",
    "provider_reconnecting",
    "text_delta",
  ]);
  assert.equal(events[1].discardTextLength, 1);
});

test("半个 SSE JSON 帧在 EOF 时会重连", async () => {
  const events = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      const stream = requestCount === 1
        ? `${frame("message", { choices: [{ delta: { content: "旧" } }] })}data: {"choices":[{"delta":{"content":"partial`
        : completedChatStream("新");
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const response = await client.create({ input, onEvent: (event) => events.push(event) });

  assert.equal(requestCount, 2);
  assert.equal(response.output[0].content[0].text, "新");
  assert.deepEqual(events.map((event) => event.type), [
    "text_delta",
    "stream_reset",
    "provider_reconnecting",
    "text_delta",
  ]);
});

test("默认 SSE 错误事件不进入重连", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(`data: ${JSON.stringify({ error: { message: "quota exhausted" } })}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  await assert.rejects(
    () => client.create({ input, onEvent() {} }),
    (error) => error?.code === "PROVIDER_STREAM_ERROR",
  );
  assert.equal(requestCount, 1);
});

test("不完整的 Responses 终态事件不被视为成功", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(frame("response.completed", {
        type: "response.completed",
        response: {},
      }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  await assert.rejects(
    () => client.create({ input, onEvent() {} }),
    (error) => error?.code === "PROVIDER_RESPONSE_INVALID",
  );
  assert.equal(requestCount, 1);
});

test("完整但空的 SSE JSON 不进入重连", async () => {
  const cases = [
    {
      protocol: "openai-chat-completions",
      endpoint: "https://api.example/v1/chat/completions",
      event: "message",
    },
    {
      protocol: "openai-responses",
      endpoint: "https://api.example/v1/responses",
      event: "response.created",
    },
  ];

  for (const item of cases) {
    let requestCount = 0;
    const client = createProviderClient({
      configLoader: async () => config(item.protocol, item.endpoint),
      reconnectDelayMs: 0,
      maxReconnectAttempts: 1,
      fetchImpl: async () => {
        requestCount += 1;
        return new Response(frame(item.event, {}), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    await assert.rejects(
      () => client.create({ input, onEvent() {} }),
      (error) => error?.code === "PROVIDER_RESPONSE_INVALID",
    );
    assert.equal(requestCount, 1);
  }
});

test("重连耗尽仍会撤销最后失败尝试的文字", async () => {
  const events = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      const text = requestCount === 1 ? "旧" : "末";
      return new Response(frame("message", { choices: [{ delta: { content: text } }] }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  await assert.rejects(
    () => client.create({ input, onEvent: (event) => events.push(event) }),
    (error) => error?.code === "PROVIDER_UNAVAILABLE",
  );

  assert.equal(requestCount, 2);
  assert.deepEqual(events.map((event) => event.type), [
    "text_delta",
    "stream_reset",
    "provider_reconnecting",
    "text_delta",
    "stream_reset",
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "stream_reset").map((event) => event.discardTextLength),
    [1, 1],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "provider_reconnecting").map((event) => event.attempt),
    [1],
  );
});

test("合法 SSE JSON 的协议结构错误不进入重连", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(frame("message", { choices: {} }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  await assert.rejects(
    () => client.create({ input, onEvent() {} }),
    (error) => error?.code === "PROVIDER_RESPONSE_INVALID",
  );
  assert.equal(requestCount, 1);
});

test("SSE socket 中断会重连并保留流式重置事件", async () => {
  const events = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      const body = requestCount === 1
        ? interruptedStream(frame("message", { choices: [{ delta: { content: "断" } }] }))
        : completedChatStream("续");
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const response = await client.create({ input, onEvent: (event) => events.push(event) });

  assert.equal(requestCount, 2);
  assert.equal(response.output[0].content[0].text, "续");
  assert.equal(events.find((event) => event.type === "stream_reset")?.discardTextLength, 1);
  assert.equal(events.find((event) => event.type === "provider_reconnecting")?.attempt, 1);
});

test("收到协议终止标记后不因后续 socket 错误重放请求", async () => {
  let requestCount = 0;
  const events = [];
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    reconnectDelayMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(interruptedStream(completedChatStream("完成")), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const response = await client.create({ input, onEvent: (event) => events.push(event) });

  assert.equal(response.output[0].content[0].text, "完成");
  assert.equal(requestCount, 1);
  assert.equal(events.some((event) => event.type === "provider_reconnecting"), false);
});
