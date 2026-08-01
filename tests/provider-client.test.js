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

async function run(protocol, endpoint, payload, check) {
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
  const response = await client.create({ input });
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
    assert.equal(response.output[0].content[0].text, "完成");
  });
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
