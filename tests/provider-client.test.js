import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "../src/server/provider-client.js";

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
    candidates: [{ content: { parts: [{ functionCall: { id: "call_2", name: "read_range", args: {} } }] } }],
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
      payload: { content: [{ type: "text", text: "继续" }] },
      getResult(body) {
        return body.messages
          .flatMap((item) => Array.isArray(item.content) ? item.content : [])
          .find((item) => item.type === "tool_result").content;
      },
    },
    {
      protocol: "google-gemini",
      endpoint: "https://api.example/v1beta/models/gemini-2.5-flash:generateContent",
      payload: { candidates: [{ content: { parts: [{ text: "继续" }] } }] },
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
