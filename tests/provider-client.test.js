import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_INSTRUCTIONS, createProviderClient } from "../src/server/provider-client.js";

const image = "data:image/png;base64,WA==";
const input = [
  {
    role: "user",
    content: [
      { type: "input_text", text: "读取 A1" },
      { type: "input_image", image_url: image },
    ],
  },
  {
    type: "function_call",
    name: "read_range",
    call_id: "call_1",
    arguments: '{"worksheet":"Sheet1","address":"A1:B2"}',
  },
  {
    type: "function_call_output",
    call_id: "call_1",
    output: '{"ok":true,"values":[[1,2]]}',
  },
];

const recoverableError = {
  ok: false,
  error: {
    code: "RANGE_ADDRESS_INVALID",
    message: "$.address 必须是有效 A1 范围。",
    path: "$.address",
    recoverable: true,
  },
};

const recoverableInput = [
  { role: "user", content: [{ type: "input_text", text: "调整 N 到 R 列" }] },
  {
    type: "function_call",
    name: "autofit_range",
    call_id: "call_invalid_range",
    arguments: '{"worksheet":null,"address":"N through R","columns":true,"rows":false}',
  },
  {
    type: "function_call_output",
    call_id: "call_invalid_range",
    output: JSON.stringify(recoverableError),
  },
];

test("Agent 指令要求公式优先和写后核验，但保留用户选择的审批模式", () => {
  assert.match(AGENT_INSTRUCTIONS, /优先写入 Excel 公式而非静态值/);
  assert.match(AGENT_INSTRUCTIONS, /先读取必要的工作簿上下文/);
  assert.match(AGENT_INSTRUCTIONS, /检查工具结果中的 impact 和 verification/);
  assert.match(
    AGENT_INSTRUCTIONS,
    /任务窗格会按照用户当前选择的审批模式处理修改工具；不得规避、合并隐藏或诱导改变该模式。/,
  );
});

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

function transportError(code = "ECONNRESET") {
  const error = new TypeError("fetch failed");
  error.cause = { code };
  return error;
}

function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function run(protocol, endpoint, payload, check, requestInput = input) {
  let captured;
  const client = createProviderClient({
    configLoader: async () => config(protocol, endpoint),
    fetchImpl: async (url, options) => {
      captured = { url, headers: options.headers, body: JSON.parse(options.body) };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const response = await client.create({ input: requestInput });
  check(captured, response);
}

test("OpenAI Responses 保持无状态请求并归一化输出", async () => {
  await run("openai-responses", "https://api.example/v1/responses", {
    output: [{ type: "function_call", name: "read_range", call_id: "call_2", arguments: "{}" }],
    usage: { total_tokens: 12 },
  }, (request, response) => {
    assert.equal(request.headers.Authorization, "Bearer provider-secret");
    assert.equal(request.body.store, false);
    assert.equal(request.body.parallel_tool_calls, false);
    assert.equal(request.body.input[0].content[1].type, "input_image");
    assert.equal(response.output[0].call_id, "call_2");
    assert.equal(response.usage.total_tokens, 12);
  });
});

test("Chat Completions 转换图片、工具和工具结果", async () => {
  await run("openai-chat-completions", "https://api.example/v1/chat/completions", {
    choices: [{ message: { role: "assistant", content: "完成", tool_calls: [] } }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }, (request, response) => {
    assert.equal(request.headers.Authorization, "Bearer provider-secret");
    assert.equal(request.body.messages[1].content[1].type, "image_url");
    assert.equal(request.body.messages[2].tool_calls[0].function.name, "read_range");
    assert.equal(request.body.messages[3].tool_call_id, "call_1");
    assert.equal(Object.hasOwn(request.body, "thinking"), false);
    assert.equal(response.output[0].content[0].text, "完成");
  });
});

test("DeepSeek V4 Flash 按官方 Chat Completions 格式控制思考", async () => {
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
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "完成", tool_calls: [] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    await client.create({ input: [] });

    assert.deepEqual(captured.thinking, { type: effort === "none" ? "disabled" : "enabled" });
    if (effort === "none") assert.equal(Object.hasOwn(captured, "reasoning_effort"), false);
    else assert.equal(captured.reasoning_effort, effort);
  }
});

test("DeepSeek V4 Responses 将 none 显式发送为 reasoning.effort", async () => {
  let captured;
  const client = createProviderClient({
    configLoader: async () => ({
      ...config("openai-responses", "https://api.example/v1/responses"),
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
    }),
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.create({ input: [] });

  assert.deepEqual(captured.reasoning, { effort: "none" });
});

test("Anthropic Messages 使用 base64 图片和 tool_result", async () => {
  await run("anthropic-messages", "https://api.example/v1/messages", {
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "完成" },
      { type: "tool_use", id: "call_2", name: "read_range", input: {} },
    ],
    usage: { input_tokens: 8, output_tokens: 4 },
  }, (request, response) => {
    assert.equal(request.headers["x-api-key"], "provider-secret");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.body.messages[0].content[1].source.media_type, "image/png");
    assert.equal(request.body.messages[1].content[0].type, "tool_use");
    assert.equal(request.body.messages[2].content[0].type, "tool_result");
    assert.equal(response.output.find((item) => item.type === "function_call").call_id, "call_2");
  });
});

test("Gemini generateContent 使用 inlineData 和 functionResponse", async () => {
  await run("google-gemini", "https://api.example/v1beta/models/gemini-2.5-flash:generateContent", {
    candidates: [{
      content: { parts: [{ functionCall: { id: "call_2", name: "read_range", args: {} } }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
  }, (request, response) => {
    assert.equal(request.headers["x-goog-api-key"], "provider-secret");
    assert.equal(request.body.contents[0].parts[1].inlineData.mimeType, "image/png");
    assert.equal(request.body.contents[1].role, "model");
    assert.equal(request.body.contents[2].parts[0].functionResponse.name, "read_range");
    assert.equal(response.output.find((item) => item.type === "function_call").call_id, "call_2");
    assert.equal(response.usage.total_tokens, 12);
  });
});

test("四种协议原样携带可恢复失败工具结果", async () => {
  const cases = [
    {
      protocol: "openai-responses",
      endpoint: "https://api.example/v1/responses",
      payload: { output: [{ type: "message", role: "assistant", content: [] }] },
      getResult(body) {
        return body.input.find((item) => item.type === "function_call_output").output;
      },
    },
    {
      protocol: "openai-chat-completions",
      endpoint: "https://api.example/v1/chat/completions",
      payload: { choices: [{ message: { role: "assistant", content: "继续", tool_calls: [] } }] },
      getResult(body) {
        return body.messages.find((item) => item.role === "tool").content;
      },
    },
    {
      protocol: "anthropic-messages",
      endpoint: "https://api.example/v1/messages",
      payload: { type: "message", role: "assistant", content: [{ type: "text", text: "继续" }] },
      getResult(body) {
        return body.messages
          .flatMap((item) => Array.isArray(item.content) ? item.content : [])
          .find((item) => item.type === "tool_result").content;
      },
    },
    {
      protocol: "google-gemini",
      endpoint: "https://api.example/v1beta/models/gemini-2.5-flash:generateContent",
      payload: { candidates: [{ content: { parts: [{ text: "继续" }] }, finishReason: "STOP" }] },
      getResult(body) {
        const result = body.contents
          .flatMap((item) => item.parts)
          .find((item) => item.functionResponse)
          .functionResponse;
        assert.equal(result.name, "autofit_range");
        assert.equal(result.id, "call_invalid_range");
        return result.response;
      },
    },
  ];

  for (const item of cases) {
    await run(item.protocol, item.endpoint, item.payload, (request) => {
      const result = item.getResult(request.body);
      assert.deepEqual(typeof result === "string" ? JSON.parse(result) : result, recoverableError);
    }, recoverableInput);
  }
});

test("模型发现以外的生成错误也会统一脱敏认证信息", async () => {
  const secretMarkers = ["provider-secret", "json-secret", "basic-secret", "bearer-secret", "query-secret"];
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    fetchImpl: async () => new Response([
      '{"token":"json-secret","authorization":"Basic basic-secret"}',
      "Authorization: Bearer bearer-secret",
      "https://provider.example/error?access_token=query-secret",
      "provider-secret",
    ].join(" "), { status: 401 }),
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => {
      assert.equal(error?.code, "PROVIDER_HTTP_ERROR");
      for (const marker of secretMarkers) assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
});

test("Anthropic 和 Gemini 的畸形 HTTP 200 不会变成空成功或重连", async () => {
  const cases = [
    {
      protocol: "anthropic-messages",
      endpoint: "https://api.example/v1/messages",
      stream: false,
    },
    {
      protocol: "google-gemini",
      endpoint: "https://api.example/v1beta/models/gemini-2.5-flash:generateContent",
      stream: false,
    },
    {
      protocol: "anthropic-messages",
      endpoint: "https://api.example/v1/messages",
      stream: true,
      body: sseFrame("message_stop", { status: "ok" }),
    },
    {
      protocol: "google-gemini",
      endpoint: "https://api.example/v1beta/models/gemini-2.5-flash:generateContent",
      stream: true,
      body: sseFrame("message", { status: "ok" }),
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
        return new Response(item.body ?? JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": item.stream ? "text/event-stream" : "application/json" },
        });
      },
    });

    await assert.rejects(
      () => client.create({ input: [], ...(item.stream ? { onEvent() {} } : {}) }),
      (error) => error?.code === "PROVIDER_RESPONSE_INVALID",
    );
    assert.equal(requestCount, 1);
  }
});

test("Anthropic 流式 thinking 签名和 redacted thinking 会随工具结果原样续传", async () => {
  const requests = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("anthropic-messages", "https://api.example/v1/messages"),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      requestCount += 1;
      if (requestCount === 1) {
        return new Response([
          sseFrame("message_start", { type: "message_start", message: { role: "assistant", usage: { input_tokens: 1 } } }),
          sseFrame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
          sseFrame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "先读取范围。" } }),
          sseFrame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "stream-signature" } }),
          sseFrame("content_block_stop", { index: 0 }),
          sseFrame("content_block_start", { index: 1, content_block: { type: "redacted_thinking", data: "opaque-redacted" } }),
          sseFrame("content_block_stop", { index: 1 }),
          sseFrame("content_block_start", { index: 2, content_block: { type: "tool_use", id: "tool-1", name: "read_range", input: {} } }),
          sseFrame("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"address":"A1"}' } }),
          sseFrame("content_block_stop", { index: 2 }),
          sseFrame("message_delta", { usage: { output_tokens: 1 } }),
          sseFrame("message_stop", { type: "message_stop" }),
        ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "已完成。" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const firstInput = [{ role: "user", content: [{ type: "input_text", text: "读取 A1" }] }];
  const first = await client.create({ input: firstInput, onEvent() {} });

  assert.deepEqual(first.output.slice(0, 2), [
    { type: "reasoning", thinking: "先读取范围。", signature: "stream-signature" },
    { type: "reasoning", redacted: true, data: "opaque-redacted" },
  ]);

  await client.create({
    input: [
      ...firstInput,
      ...first.output,
      { type: "function_call_output", call_id: "tool-1", output: '{"ok":true}' },
    ],
  });

  const assistant = requests[1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.content, [
    { type: "thinking", thinking: "先读取范围。", signature: "stream-signature" },
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "tool_use", id: "tool-1", name: "read_range", input: { address: "A1" } },
  ]);
});

test("Anthropic 非流式 redacted thinking 也会在工具续传中保留", async () => {
  const requests = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("anthropic-messages", "https://api.example/v1/messages"),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      requestCount += 1;
      const payload = requestCount === 1
        ? {
            type: "message",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "nonstream-signature" },
              { type: "redacted_thinking", data: "nonstream-redacted" },
              { type: "tool_use", id: "tool-2", name: "read_range", input: {} },
            ],
          }
        : { type: "message", role: "assistant", content: [{ type: "text", text: "已完成。" }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const firstInput = [{ role: "user", content: [{ type: "input_text", text: "读取 A1" }] }];
  const first = await client.create({ input: firstInput });

  await client.create({
    input: [
      ...firstInput,
      ...first.output,
      { type: "function_call_output", call_id: "tool-2", output: '{"ok":true}' },
    ],
  });

  const assistant = requests[1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.content.slice(0, 2), [
    { type: "thinking", thinking: "", signature: "nonstream-signature" },
    { type: "redacted_thinking", data: "nonstream-redacted" },
  ]);
});

test("连接失败后每三秒重连，恢复后继续当前模型步骤", async () => {
  const events = [];
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    reconnectDelayMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount < 3) throw transportError("ENETDOWN");
      return new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const response = await client.create({ input: [], onEvent: (event) => events.push(event) });

  assert.deepEqual(response.output, []);
  assert.equal(requestCount, 3);
  assert.deepEqual(events.filter((event) => event.type === "provider_reconnecting").map((event) => event.attempt), [1, 2]);
  assert.equal(events.find((event) => event.type === "provider_reconnecting")?.delayMs, 0);
});

test("十次重连全部失败后才报告提供方不可用", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    reconnectDelayMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      throw transportError();
    },
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => error?.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(requestCount, 11);
});

test("标准 fetch 网络错误会重连", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const response = await client.create({ input: [] });

  assert.deepEqual(response.output, []);
  assert.equal(requestCount, 2);
});

test("非网络 TypeError 不进入重连", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    fetchImpl: async () => {
      requestCount += 1;
      throw new TypeError("Headers.append: invalid header value");
    },
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => error?.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(requestCount, 1);
});

test("重连等待期间取消不会发起下一次请求", async () => {
  const controller = new AbortController();
  let requestCount = 0;
  let notifyReconnect;
  const reconnecting = new Promise((resolve) => {
    notifyReconnect = resolve;
  });
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    fetchImpl: async () => {
      requestCount += 1;
      throw transportError();
    },
  });

  const request = client.create({
    input: [],
    signal: controller.signal,
    onEvent(event) {
      if (event.type === "provider_reconnecting") {
        assert.equal(event.delayMs, 3_000);
        notifyReconnect();
      }
    },
  });
  await reconnecting;
  controller.abort();

  await assert.rejects(
    () => request,
    (error) => error?.code === "AGENT_CANCELLED",
  );
  assert.equal(requestCount, 1);
});

test("总超时会中止重连等待且不重试", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    timeoutMs: 20,
    reconnectDelayMs: 1_000,
    fetchImpl: async () => {
      requestCount += 1;
      throw transportError();
    },
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => error?.code === "PROVIDER_TIMEOUT",
  );
  assert.equal(requestCount, 1);
});

test("HTTP、显式流错误和无效响应不进入重连", async () => {
  const cases = [
    {
      response: () => new Response("unauthorized", { status: 401 }),
      options: {},
      errorCode: "PROVIDER_HTTP_ERROR",
    },
    {
      response: () => new Response("not-json", { headers: { "Content-Type": "application/json" } }),
      options: {},
      errorCode: "PROVIDER_RESPONSE_INVALID",
    },
    {
      response: () => new Response("event: error\ndata: {\"error\":{\"message\":\"rejected\"}}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
      options: { onEvent() {} },
      errorCode: "PROVIDER_STREAM_ERROR",
    },
  ];

  for (const item of cases) {
    let requestCount = 0;
    const client = createProviderClient({
      configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
      reconnectDelayMs: 0,
      fetchImpl: async () => {
        requestCount += 1;
        return item.response();
      },
    });

    await assert.rejects(
      () => client.create({ input: [], ...item.options }),
      (error) => error?.code === item.errorCode,
    );
    assert.equal(requestCount, 1);
  }
});

test("非成功 HTTP 响应体读取中断仍保持 HTTP 失败", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => config("openai-responses", "https://api.example/v1/responses"),
    reconnectDelayMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      const error = new TypeError("socket reset");
      error.code = "ECONNRESET";
      const body = new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      });
      return new Response(body, { status: 401 });
    },
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => error?.code === "PROVIDER_HTTP_ERROR",
  );
  assert.equal(requestCount, 1);
});

test("令牌包含换行时立即失败且不重连", async () => {
  let requestCount = 0;
  const client = createProviderClient({
    configLoader: async () => ({
      ...config("openai-responses", "https://api.example/v1/responses"),
      token: "provider\nsecret",
    }),
    reconnectDelayMs: 0,
    maxReconnectAttempts: 2,
    fetchImpl: async () => {
      requestCount += 1;
      throw transportError();
    },
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => error?.code === "PROVIDER_AUTH_INVALID",
  );
  assert.equal(requestCount, 0);
});
