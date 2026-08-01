import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { createApp } from "../src/server/http-app.js";

const fakeSecret = "integration-test-secret";

function fakeConfig() {
  return {
    providerId: "custom",
    providerName: "Test Provider",
    model: "gpt-test",
    responsesUrl: "http://127.0.0.1:8080/responses?private=value",
    wireApi: "responses",
    token: fakeSecret,
    tokenSource: "config",
  };
}

async function startServer(t, options = {}) {
  const allowedHosts = new Set();
  const app = createApp({
    configLoader: async () => fakeConfig(),
    allowedHosts,
    allowedOrigins: new Set(["https://localhost:3210"]),
    ...options,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  allowedHosts.add(`127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

test("健康接口无需模型配置即可访问", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("脱敏配置接口不返回令牌或查询参数", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: "https://localhost:3210" },
  });
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.config.endpoint, "http://127.0.0.1:8080/responses");
  assert.equal(text.includes(fakeSecret), false);
  assert.equal(text.includes("private=value"), false);
});

test("拒绝未授权 Origin", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: "https://untrusted.example" },
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ORIGIN_FORBIDDEN");
});

test("拒绝未授权 Host", async (t) => {
  const baseUrl = await startServer(t);
  const target = new URL("/api/health", baseUrl);
  const response = await new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { Host: "untrusted.example" },
    });
    outgoing.on("response", (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => {
        body += chunk;
      });
      incoming.on("end", () => resolve({ status: incoming.statusCode, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

  assert.equal(response.status, 421);
  assert.equal(JSON.parse(response.body).error.code, "HOST_FORBIDDEN");
});

test("Agent 写接口必须来自同源任务窗格并使用 JSON", async (t) => {
  const baseUrl = await startServer(t);
  const missingOrigin = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "test" }),
  });
  const wrongType = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "text/plain",
    },
    body: "test",
  });

  assert.equal(missingOrigin.status, 403);
  assert.equal(wrongType.status, 415);
});

test("设置接口拒绝超过限制的 JSON 请求体", async (t) => {
  const baseUrl = await startServer(t, {
    runtimeConfigStore: { async update() { throw new Error("不应执行"); } },
  });
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ apiKey: "x".repeat(70 * 1024) }),
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "REQUEST_TOO_LARGE");
});

test("设置接口传递协议和最大步骤数并返回脱敏状态", async (t) => {
  let captured;
  const state = {
    source: "system",
    config: { providerName: "Test", model: "gpt-test", endpoint: "https://api.example/v1/responses" },
    models: [],
    protocols: [{ id: "openai-responses", label: "OpenAI Responses" }],
    settings: { useSystemConfig: true, maxSteps: 100, credentialConfigured: false },
  };
  const runtimeConfigStore = {
    async getPublicState() { return state; },
    async update(settings) {
      captured = settings;
      return { ...state, settings: { ...state.settings, maxSteps: settings.maxSteps } };
    },
  };
  const baseUrl = await startServer(t, { runtimeConfigStore });
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ useSystemConfig: true, protocol: "openai-responses", maxSteps: 100 }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(captured.protocol, "openai-responses");
  assert.equal(captured.maxSteps, 100);
  assert.equal(body.settings.maxSteps, 100);
  assert.equal(JSON.stringify(body).includes(fakeSecret), false);
});

test("Agent 接口把图片和模型选项传给会话管理器", async (t) => {
  let captured;
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start(message, sessionId, options) {
        captured = { message, sessionId, options };
        return { sessionId, status: "completed", message: "ok" };
      },
    },
  });
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "session-http-01",
      message: "分析图片",
      attachments: [{ dataUrl: "data:image/png;base64,YQ==" }],
      model: "gpt-5-test",
      reasoningEffort: "high",
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(captured.options.model, "gpt-5-test");
  assert.equal(captured.options.reasoningEffort, "high");
  assert.equal(captured.options.attachments.length, 1);
});

test("Agent 接口在事件流请求中转发增量并发送最终结果", async (t) => {
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start(message, sessionId, options, hooks) {
        hooks.onEvent?.({ type: "text_delta", text: "流" });
        return { sessionId, status: "completed", message: "流式完成", step: 1 };
      },
      async cancel() {},
    },
  });
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-stream-01", message: "流式" }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(body, /event: delta/);
  assert.match(body, /"text_delta"/);
  assert.match(body, /event: result/);
  assert.match(body, /流式完成/);
  assert.match(body, /event: done/);
});
