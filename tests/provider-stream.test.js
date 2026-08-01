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
        frame("message_stop", {}),
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
        frame("message", { candidates: [{ content: { parts: [{ text: "好" }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } }),
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

test("流式工具参数完整后才归一化为调用", async () => {
  const client = createProviderClient({
    configLoader: async () => config("openai-chat-completions", "https://api.example/v1/chat/completions"),
    fetchImpl: async () => new Response([
      frame("message", { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_range", arguments: "{\"address\":" } }] } }] }),
      frame("message", { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"A1\"}" } }] } }] }),
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
