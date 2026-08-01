import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createResponsesClient, ProviderError } from "../src/server/responses-client.js";

async function startProvider(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}/responses`;
}

function makeConfig(responsesUrl, overrides = {}) {
  return {
    model: "gpt-test",
    responsesUrl,
    token: "provider-test-secret",
    reasoningEffort: "high",
    verbosity: "medium",
    contextWindow: 128000,
    ...overrides,
  };
}

test("Responses 请求固定使用无存储串行严格工具", async (t) => {
  let captured;
  const responsesUrl = await startProvider(t, (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      captured = { authorization: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", output: [] }));
    });
  });
  const client = createResponsesClient({ configLoader: async () => makeConfig(responsesUrl) });

  await client.create({ input: [{ role: "user", content: "test" }] });

  assert.equal(captured.authorization, "Bearer provider-test-secret");
  assert.equal(captured.body.model, "gpt-test");
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.parallel_tool_calls, false);
  assert.deepEqual(captured.body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(captured.body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(captured.body.text, { verbosity: "medium" });
  assert.equal(captured.body.tools.length, 14);
  assert.equal(captured.body.tools.every((tool) => tool.strict === true), true);
  assert.equal(JSON.stringify(captured.body).includes("provider-test-secret"), false);
});

test("每个模型步骤重新加载当前配置", async () => {
  const models = ["model-first", "model-second"];
  const requested = [];
  let loadCount = 0;
  const client = createResponsesClient({
    configLoader: async () => makeConfig("https://provider.example/responses", {
      model: models[loadCount++],
    }),
    fetchImpl: async (_url, options) => {
      requested.push(JSON.parse(options.body).model);
      return new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.create({ input: [] });
  await client.create({ input: [] });

  assert.equal(loadCount, 2);
  assert.deepEqual(requested, models);
});

test("消息级模型选项传入配置解析并返回运行时上下文", async () => {
  let receivedOptions;
  const client = createResponsesClient({
    configLoader: async (options) => {
      receivedOptions = options;
      return makeConfig("https://provider.example/responses", {
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ output: [], usage: { total_tokens: 50 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  const response = await client.create({
    input: [],
    options: { model: "gpt-selected", reasoningEffort: "low" },
  });

  assert.deepEqual(receivedOptions, { model: "gpt-selected", reasoningEffort: "low" });
  assert.deepEqual(response.__chatExcel, {
    model: "gpt-selected",
    reasoningEffort: "low",
    contextWindow: 128000,
  });
});

test("上游 HTTP 错误会脱敏令牌并保留状态", async () => {
  const token = "provider-test-secret";
  const client = createResponsesClient({
    configLoader: async () => makeConfig("https://provider.example/responses", { token }),
    fetchImpl: async () =>
      new Response(`Authorization: Bearer ${token} rejected`, {
        status: 401,
        headers: { "x-request-id": "req_test" },
      }),
  });

  await assert.rejects(
    () => client.create({ input: [] }),
    (error) => {
      assert.equal(error instanceof ProviderError, true);
      assert.equal(error.code, "PROVIDER_HTTP_ERROR");
      assert.equal(error.providerStatus, 401);
      assert.equal(error.requestId, "req_test");
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});

test("上游超时和无效 JSON 返回可诊断错误", async (t) => {
  const responsesUrl = await startProvider(t, (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not-json");
    }, 80);
  });
  const timeoutClient = createResponsesClient({
    configLoader: async () => makeConfig(responsesUrl),
    timeoutMs: 20,
  });

  await assert.rejects(
    () => timeoutClient.create({ input: [] }),
    (error) => error instanceof ProviderError && error.code === "PROVIDER_TIMEOUT",
  );

  const invalidClient = createResponsesClient({
    configLoader: async () => makeConfig("https://provider.example/responses"),
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    () => invalidClient.create({ input: [] }),
    (error) => error instanceof ProviderError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});
