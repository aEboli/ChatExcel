import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { createApp } from "../src/server/http-app.js";
import { APP_NAME, APP_VERSION } from "../src/shared/app-info.js";

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
  assert.equal(body.service, APP_NAME);
  assert.equal(body.version, APP_VERSION);
  assert.deepEqual(body.capabilities, ["office-addin", "native-xls"]);
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

test("提供方连通性接口仅接受同源 JSON，并忽略客户端请求体", async (t) => {
  const probeArguments = [];
  const baseUrl = await startServer(t, {
    runtimeConfigStore: {
      async probeCurrentProvider(...args) {
        probeArguments.push(args);
        return { status: "connected" };
      },
    },
  });
  const missingOrigin = await fetch(`${baseUrl}/api/provider-connectivity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: fakeSecret, useSystemConfig: false }),
  });

  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, "ORIGIN_FORBIDDEN");
  assert.deepEqual(probeArguments, []);

  const accepted = await fetch(`${baseUrl}/api/provider-connectivity`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiKey: fakeSecret,
      apiUrl: "https://untrusted.example/v1/responses",
      useSystemConfig: false,
    }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await accepted.json(), { ok: true, connectivity: { status: "connected" } });
  assert.deepEqual(probeArguments, [[]]);
});

test("提供方连通性失败仍返回脱敏状态", async (t) => {
  let probeCalls = 0;
  const baseUrl = await startServer(t, {
    runtimeConfigStore: {
      async probeCurrentProvider() {
        probeCalls += 1;
        return { status: "failed", code: "PROVIDER_UNAVAILABLE" };
      },
    },
  });
  const response = await fetch(`${baseUrl}/api/provider-connectivity`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ apiKey: fakeSecret, endpoint: `https://example.test/${fakeSecret}` }),
  });
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    connectivity: { status: "failed", code: "PROVIDER_UNAVAILABLE" },
  });
  assert.equal(text.includes(fakeSecret), false);
  assert.equal(probeCalls, 1);
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

test("审批偏好接口仅接受受信任来源和有效枚举", async (t) => {
  let approvalMode = "required";
  const state = {
    source: "system",
    config: { providerName: "Test", model: "gpt-test", endpoint: "https://api.example/v1/responses" },
    models: [],
    protocols: [],
    settings: { useSystemConfig: true, maxSteps: 100, approvalMode, credentialConfigured: false },
  };
  const runtimeConfigStore = {
    async updateApprovalMode(nextMode) {
      if (nextMode !== "required" && nextMode !== "auto") {
        const error = new Error("审批模式无效。");
        error.code = "APPROVAL_MODE_INVALID";
        error.statusCode = 400;
        error.expose = true;
        throw error;
      }
      approvalMode = nextMode;
      return { ...state, settings: { ...state.settings, approvalMode } };
    },
  };
  const baseUrl = await startServer(t, { runtimeConfigStore });
  const missingOrigin = await fetch(`${baseUrl}/api/settings/approval-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalMode: "auto" }),
  });
  const accepted = await fetch(`${baseUrl}/api/settings/approval-mode`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ approvalMode: "auto" }),
  });
  const invalid = await fetch(`${baseUrl}/api/settings/approval-mode`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ approvalMode: "ask" }),
  });

  assert.equal(missingOrigin.status, 403);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).settings.approvalMode, "auto");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "APPROVAL_MODE_INVALID");
  assert.equal(approvalMode, "auto");
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
      workbookBinding: "https://example.test/workbooks/budget.xlsx",
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(captured.options.model, "gpt-5-test");
  assert.equal(captured.options.reasoningEffort, "high");
  assert.equal(captured.options.attachments.length, 1);
  assert.equal(captured.options.workbookBinding, "https://example.test/workbooks/budget.xlsx");
});

test("Agent 接口允许仅图片请求并保留附件", async (t) => {
  let captured;
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start(message, sessionId, options) {
        captured = { message, sessionId, options };
        return { sessionId, status: "completed", message: "ok" };
      },
    },
  });
  const attachments = [{ name: "截图.png", dataUrl: "data:image/png;base64,YQ==" }];
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "session-http-image-only-01",
      message: "",
      attachments,
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(captured.message, "");
  assert.deepEqual(captured.options.attachments, attachments);
});

test("Agent 后续消息接口把工作簿绑定传给会话管理器", async (t) => {
  let captured;
  const baseUrl = await startServer(t, {
    sessionManager: {
      async addMessage(sessionId, message, options) {
        captured = { sessionId, message, options };
        return { sessionId, status: "completed", message: "ok" };
      },
    },
  });
  const response = await fetch(`${baseUrl}/api/sessions/session-http-binding-01/messages`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "继续分析",
      workbookBinding: "document-url:C:/reports/copy.xlsx",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    sessionId: "session-http-binding-01",
    message: "继续分析",
    options: {
      attachments: undefined,
      model: undefined,
      reasoningEffort: undefined,
      workbookBinding: "document-url:C:/reports/copy.xlsx",
    },
  });
});

test("会话恢复接口受同源保护、禁止缓存且只返回可见消息", async (t) => {
  const restoreCalls = [];
  const rawInput = "恢复接口不得返回的原始模型输入";
  const baseUrl = await startServer(t, {
    sessionManager: {
      async restore(workbookBinding) {
        restoreCalls.push(workbookBinding);
        return {
          sessionId: "session-recovery-http-01",
          presentation: {
            messages: [
              { role: "user", text: "请分析本月收入" },
              { role: "assistant", text: "我会先读取工作簿。" },
              { role: "tool", text: rawInput },
            ],
          },
          recovery: { notice: "model_request_interrupted" },
          input: [{ role: "user", content: rawInput }],
        };
      },
    },
  });
  const missingOrigin = await fetch(`${baseUrl}/api/conversation-recovery/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workbookBinding: "workbook://budget" }),
  });
  const wrongType = await fetch(`${baseUrl}/api/conversation-recovery/restore`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "text/plain",
    },
    body: "workbook://budget",
  });

  assert.equal(missingOrigin.status, 403);
  assert.equal(wrongType.status, 415);
  assert.equal(missingOrigin.headers.get("cache-control"), "no-store");
  assert.equal(wrongType.headers.get("cache-control"), "no-store");
  assert.deepEqual(restoreCalls, []);

  const response = await fetch(`${baseUrl}/api/conversation-recovery/restore`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workbookBinding: "workbook://budget" }),
  });
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    ok: true,
    recovery: {
      status: "available",
      sessionId: "session-recovery-http-01",
      presentationMessages: [
        { role: "user", text: "请分析本月收入" },
        { role: "assistant", text: "我会先读取工作簿。" },
      ],
      interrupted: true,
      notice: "model_request_interrupted",
    },
  });
  assert.equal(text.includes(rawInput), false);
  assert.deepEqual(restoreCalls, ["workbook://budget"]);
});

test("会话恢复仅公开安全的不可用状态", async (t) => {
  let status = "expired";
  const baseUrl = await startServer(t, {
    sessionManager: {
      async restore() {
        return { recovery: { status } };
      },
    },
  });
  const request = () => fetch(`${baseUrl}/api/conversation-recovery/restore`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workbookBinding: "workbook://budget" }),
  });

  assert.deepEqual(await (await request()).json(), {
    ok: true,
    recovery: { status: "expired" },
  });

  status = "unavailable";
  assert.deepEqual(await (await request()).json(), {
    ok: true,
    recovery: { status: "unavailable" },
  });

  status = "mismatch";
  assert.deepEqual(await (await request()).json(), {
    ok: true,
    recovery: { status: "missing" },
  });
});

test("会话恢复心跳和清除接口使用同源保护且禁止缓存", async (t) => {
  const touchCalls = [];
  const cancelCalls = [];
  const baseUrl = await startServer(t, {
    sessionManager: {
      async touchRecovery(sessionId, workbookBinding) {
        touchCalls.push({ sessionId, workbookBinding });
        return true;
      },
      async clearRecoverySession(sessionId) {
        cancelCalls.push(sessionId);
      },
    },
  });
  const missingOrigin = await fetch(`${baseUrl}/api/conversation-recovery/touch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "session-recovery-http-02", workbookBinding: "workbook://budget" }),
  });
  const touch = await fetch(`${baseUrl}/api/conversation-recovery/touch`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-recovery-http-02", workbookBinding: "workbook://budget" }),
  });
  const clear = await fetch(`${baseUrl}/api/conversation-recovery/session-recovery-http-02`, {
    method: "DELETE",
    headers: { Origin: "https://localhost:3210" },
  });

  assert.equal(missingOrigin.status, 403);
  assert.equal(touch.status, 200);
  assert.equal(touch.headers.get("cache-control"), "no-store");
  assert.deepEqual(await touch.json(), { ok: true, active: { status: "touched" } });
  assert.equal(clear.status, 204);
  assert.equal(clear.headers.get("cache-control"), "no-store");
  assert.deepEqual(touchCalls, [{
    sessionId: "session-recovery-http-02",
    workbookBinding: "workbook://budget",
  }]);
  assert.deepEqual(cancelCalls, ["session-recovery-http-02"]);
});

test("恢复快照无法确认删除时清除接口返回可重试错误", async (t) => {
  const baseUrl = await startServer(t, {
    sessionManager: {
      async clearRecoverySession() {
        const error = new Error("无法确认本地恢复记录已清除，请稍后重试。");
        error.code = "RECOVERY_CLEAR_UNAVAILABLE";
        error.statusCode = 503;
        error.expose = true;
        throw error;
      },
    },
  });

  const response = await fetch(`${baseUrl}/api/conversation-recovery/session-retry-01`, {
    method: "DELETE",
    headers: { Origin: "https://localhost:3210" },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "RECOVERY_CLEAR_UNAVAILABLE",
      message: "无法确认本地恢复记录已清除，请稍后重试。",
    },
  });
});

test("会话恢复心跳向任务窗格公开可安全处理的不可用状态", async (t) => {
  const baseUrl = await startServer(t, {
    sessionManager: {
      async touchRecovery() {
        return { status: "unavailable" };
      },
    },
  });
  const response = await fetch(`${baseUrl}/api/conversation-recovery/touch`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "session-recovery-http-03",
      workbookBinding: "workbook://budget",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, active: { status: "unavailable" } });
});

test("可恢复会话错误向事件流和 JSON 客户端声明可继续", async (t) => {
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start() {
        const error = new Error("提供方暂时不可用");
        error.code = "PROVIDER_CONNECTION_FAILED";
        error.statusCode = 503;
        error.recoverableSession = true;
        throw error;
      },
    },
  });
  const stream = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-recoverable-stream", message: "继续" }),
  });
  const json = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-recoverable-json", message: "继续" }),
  });

  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /"recoverableSession":true/);
  assert.equal(json.status, 503);
  assert.equal((await json.json()).error.recoverableSession, true);
});

test("Agent 接口在事件流请求中转发增量并发送最终结果", async (t) => {
  let cancelCount = 0;
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start(message, sessionId, options, hooks) {
        hooks.onEvent?.({ type: "text_delta", text: "流" });
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { sessionId, status: "completed", message: "流式完成", step: 1 };
      },
      async cancel() {
        cancelCount += 1;
      },
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
  assert.equal(cancelCount, 0);
});

test("Agent 事件流客户端断开时在旧会话管理器上回退取消", async (t) => {
  let releaseOperation;
  let markStarted;
  let markCancelled;
  const operationReleased = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const cancelled = new Promise((resolve) => {
    markCancelled = resolve;
  });
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start(_message, sessionId) {
        markStarted();
        await operationReleased;
        return { sessionId, status: "completed", message: "已停止", step: 0 };
      },
      async cancel(sessionId) {
        markCancelled(sessionId);
        releaseOperation();
      },
    },
  });
  const controller = new AbortController();
  const responsePromise = fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-stream-abort", message: "停止" }),
    signal: controller.signal,
  });

  await started;
  const response = await responsePromise;
  controller.abort();
  await assert.rejects(() => response.text(), (error) => error?.name === "AbortError");
  assert.equal(await cancelled, "session-stream-abort");
});

test("Agent 事件流客户端断开时优先挂起会话而不取消恢复快照", async (t) => {
  let releaseOperation;
  let markStarted;
  let markSuspended;
  let cancelCount = 0;
  const operationReleased = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const suspended = new Promise((resolve) => {
    markSuspended = resolve;
  });
  const baseUrl = await startServer(t, {
    sessionManager: {
      async start(_message, sessionId) {
        markStarted();
        await operationReleased;
        return { sessionId, status: "completed", message: "已挂起", step: 0 };
      },
      async suspend(sessionId) {
        markSuspended(sessionId);
        releaseOperation();
      },
      async cancel() {
        cancelCount += 1;
      },
    },
  });
  const controller = new AbortController();
  const responsePromise = fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-stream-suspend", message: "挂起" }),
    signal: controller.signal,
  });

  await started;
  const response = await responsePromise;
  controller.abort();
  await assert.rejects(() => response.text(), (error) => error?.name === "AbortError");
  assert.equal(await suspended, "session-stream-suspend");
  assert.equal(cancelCount, 0);
});

test("原生 XLS 端点要求受信任来源并只转发当前会话请求", async (t) => {
  let captured;
  const baseUrl = await startServer(t, {
    legacyWorkbookBridge: {
      async request(sessionId, body) {
        captured = { sessionId, body };
        return { ok: true, engine: "native-xls", label: "旧版-Sheet1" };
      },
    },
  });
  const sessionId = "b".repeat(48);
  const rejected = await fetch(`${baseUrl}/api/legacy/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "state" }),
  });
  const accepted = await fetch(`${baseUrl}/api/legacy/${sessionId}`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "state" }),
  });

  assert.equal(rejected.status, 403);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).label, "旧版-Sheet1");
  assert.deepEqual(captured, { sessionId, body: { action: "state" } });
});

test("原生 XLS 工具错误保留失败状态而不伪装成功", async (t) => {
  const baseUrl = await startServer(t, {
    legacyWorkbookBridge: {
      async request() {
        return { ok: false, error: { code: "WORKBOOK_READ_ONLY", message: "只读" } };
      },
    },
  });
  const response = await fetch(`${baseUrl}/api/legacy/${"c".repeat(48)}`, {
    method: "POST",
    headers: {
      Origin: "https://localhost:3210",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "execute", name: "write_values", arguments: {} }),
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "WORKBOOK_READ_ONLY");
});
