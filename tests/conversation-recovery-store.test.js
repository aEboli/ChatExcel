import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConversationRecoveryStore,
  ConversationRecoveryStoreError,
} from "../src/server/conversation-recovery-store.js";

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

async function createStore(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chatexcel-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new ConversationRecoveryStore({
    recoveryPath: join(directory, "conversation-recovery.json"),
    protect: async (plaintext) => encode(plaintext),
    unprotect: async (ciphertext) => decode(ciphertext),
    ...options,
  });
}

function snapshot(label = "检查库存") {
  return {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `${label}；请读取 Sheet1!A1:B2。` }],
      },
    ],
    requestOptions: { model: "gpt-test", reasoningEffort: "low" },
    stepCount: 1,
    state: "idle",
    pendingCalls: null,
  };
}

test("恢复文件仅写入加密 envelope，并可恢复单个会话", async (t) => {
  let currentTime = 10_000;
  const store = await createStore(t, { now: () => currentTime });
  const sourceSnapshot = snapshot("敏感提示词");

  const saved = await store.save({
    sessionId: "session-recovery-01",
    workbookKey: "workbook://sales-report",
    snapshot: sourceSnapshot,
  });
  const source = await readFile(store.recoveryPath, "utf8");
  const envelope = JSON.parse(source);

  assert.equal(saved.status, "saved");
  assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "version"]);
  assert.equal(envelope.version, 1);
  assert.equal(source.includes("敏感提示词"), false);
  assert.equal(source.includes("Sheet1!A1:B2"), false);

  sourceSnapshot.input[0].content[0].text = "已在内存中修改";
  const restored = await store.restore({ workbookKey: "workbook://sales-report" });

  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-recovery-01");
  assert.equal(restored.lastActiveAt, currentTime);
  assert.equal(restored.expiresAt, currentTime + store.ttlMs);
  assert.equal(restored.snapshot.input[0].content[0].text.includes("敏感提示词"), true);
});

test("一个新会话会原子覆盖旧会话，且工作簿不匹配不会泄露内容", async (t) => {
  const store = await createStore(t);
  await store.save({
    sessionId: "session-old-01",
    workbookKey: "workbook://old",
    snapshot: snapshot("旧工作簿"),
  });
  await store.save({
    sessionId: "session-new-01",
    workbookKey: "workbook://new",
    snapshot: snapshot("新工作簿"),
  });

  const oldWorkbook = await store.restore({ workbookKey: "workbook://old" });
  const newWorkbook = await store.restore({ workbookKey: "workbook://new" });

  assert.deepEqual(oldWorkbook, { status: "mismatch" });
  assert.equal(newWorkbook.status, "available");
  assert.equal(newWorkbook.sessionId, "session-new-01");
  assert.equal(newWorkbook.snapshot.input[0].content[0].text.includes("新工作簿"), true);
});

test("匹配的心跳延长滚动期限，错误的会话或工作簿无法触碰快照", async (t) => {
  let currentTime = 1_000;
  const store = await createStore(t, { now: () => currentTime, ttlMs: 100 });
  await store.save({
    sessionId: "session-touch-01",
    workbookKey: "workbook://touch",
    snapshot: snapshot(),
  });

  currentTime = 1_050;
  assert.deepEqual(
    await store.touch({ sessionId: "session-other-01", workbookKey: "workbook://touch" }),
    { status: "mismatch" },
  );
  assert.deepEqual(
    await store.touch({ sessionId: "session-touch-01", workbookKey: "workbook://other" }),
    { status: "mismatch" },
  );
  const touched = await store.touch({
    sessionId: "session-touch-01",
    workbookKey: "workbook://touch",
  });

  assert.equal(touched.status, "touched");
  assert.equal(touched.lastActiveAt, currentTime);
  currentTime = 1_149;
  assert.equal((await store.restore({ workbookKey: "workbook://touch" })).status, "available");
  currentTime = 1_150;
  assert.equal((await store.restore({ workbookKey: "workbook://touch" })).status, "expired");
});

test("模型检查点不会延长已经关闭任务窗格的恢复期限", async (t) => {
  let currentTime = 1_000;
  const store = await createStore(t, { now: () => currentTime, ttlMs: 100 });
  await store.save({
    sessionId: "session-pane-lease-01",
    workbookKey: "workbook://pane-lease",
    snapshot: snapshot("打开窗格时的对话"),
    lastPaneHeartbeatAt: currentTime,
  });

  currentTime = 1_050;
  await store.save({
    sessionId: "session-pane-lease-01",
    workbookKey: "workbook://pane-lease",
    snapshot: snapshot("窗格关闭后的模型检查点"),
    lastPaneHeartbeatAt: 1_000,
  });
  const beforeExpiry = await store.restore({ workbookKey: "workbook://pane-lease" });

  assert.equal(beforeExpiry.status, "available");
  assert.equal(beforeExpiry.lastActiveAt, 1_050);
  assert.equal(beforeExpiry.lastPaneHeartbeatAt, 1_000);
  assert.equal(beforeExpiry.snapshot.input[0].content[0].text.includes("窗格关闭后"), true);

  currentTime = 1_100;
  assert.equal((await store.restore({ workbookKey: "workbook://pane-lease" })).status, "expired");
});

test("过期和显式清除都会删除当前加密快照", async (t) => {
  let currentTime = 5_000;
  const store = await createStore(t, { now: () => currentTime, ttlMs: 100 });
  await store.save({
    sessionId: "session-expire-01",
    workbookKey: "workbook://expire",
    snapshot: snapshot(),
  });

  currentTime = 5_100;
  assert.deepEqual(await store.cleanupExpired(), { status: "expired" });
  assert.deepEqual(await store.restore({ workbookKey: "workbook://expire" }), { status: "missing" });

  await store.save({
    sessionId: "session-clear-01",
    workbookKey: "workbook://clear",
    snapshot: snapshot(),
  });
  assert.deepEqual(
    await store.clear({ sessionId: "session-other-01", workbookKey: "workbook://clear" }),
    { status: "mismatch" },
  );
  assert.deepEqual(
    await store.clear({ sessionId: "session-clear-01", workbookKey: null }),
    { status: "cleared" },
  );
  assert.deepEqual(await store.restore({ workbookKey: "workbook://clear" }), { status: "missing" });
});

test("显式清除会删除崩溃遗留的加密临时 envelope", async (t) => {
  const store = await createStore(t);
  await store.save({
    sessionId: "session-clear-temp-01",
    workbookKey: "workbook://clear-temp",
    snapshot: snapshot(),
  });
  const temporaryPath = `${store.recoveryPath}.999.orphan.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ version: 1, ciphertext: "encrypted-only" }), "utf8");

  assert.deepEqual(
    await store.clear({ sessionId: "session-clear-temp-01", workbookKey: "workbook://clear-temp" }),
    { status: "cleared" },
  );
  await assert.rejects(() => readFile(temporaryPath, "utf8"), { code: "ENOENT" });
});

test("过期清理会删除崩溃遗留超过期限的临时 envelope", async (t) => {
  let currentTime = 10_000;
  const store = await createStore(t, { now: () => currentTime, ttlMs: 100 });
  const temporaryPath = `${store.recoveryPath}.999.orphan.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ version: 1, ciphertext: "encrypted-only" }), "utf8");
  await utimes(temporaryPath, new Date(1), new Date(1));

  assert.deepEqual(await store.cleanupExpired(), { status: "missing" });
  await assert.rejects(() => readFile(temporaryPath, "utf8"), { code: "ENOENT" });
});

test("DPAPI 暂不可用时仍按文件活动时间清理过期缓存", async (t) => {
  let currentTime = 10_000;
  const store = await createStore(t, {
    now: () => currentTime,
    ttlMs: 100,
    unprotect: async () => {
      throw new Error("DPAPI unavailable");
    },
  });
  await writeFile(
    store.recoveryPath,
    JSON.stringify({ version: 1, ciphertext: "encrypted-only" }),
    "utf8",
  );
  await utimes(store.recoveryPath, new Date(1), new Date(1));

  assert.deepEqual(await store.cleanupExpired(), { status: "expired" });
  await assert.rejects(() => readFile(store.recoveryPath, "utf8"), { code: "ENOENT" });
  currentTime += 100;
});

test("生产清理工作进程只在本地快照首次写入时启动", async (t) => {
  const spawned = [];
  const store = await createStore(t, {
    cleanupWorkerEnabled: true,
    cleanupWorkerPath: "cleanup-worker.js",
    nodeExecutable: "node-test",
    spawnProcess(...args) {
      spawned.push(args);
      return { once() {}, unref() {} };
    },
  });

  await store.save({
    sessionId: "session-worker-01",
    workbookKey: "workbook://worker",
    snapshot: snapshot(),
  });
  await store.touch({ sessionId: "session-worker-01", workbookKey: "workbook://worker" });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], "node-test");
  assert.deepEqual(spawned[0][2], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.equal(spawned[0][1][0], "cleanup-worker.js");
  assert.equal(spawned[0][1][1], store.recoveryPath);
});

test("清理进程异步启动失败后不会中断保存，并会在下一次活动时重试", async (t) => {
  let spawnCount = 0;
  let failedChild;
  const store = await createStore(t, {
    cleanupWorkerEnabled: true,
    spawnProcess() {
      spawnCount += 1;
      const child = new EventEmitter();
      child.unref = () => {};
      if (spawnCount === 1) failedChild = child;
      return child;
    },
  });

  await store.save({
    sessionId: "session-worker-retry-01",
    workbookKey: "workbook://worker-retry",
    snapshot: snapshot(),
  });
  failedChild.emit("error", new Error("worker start failed"));

  await store.touch({
    sessionId: "session-worker-retry-01",
    workbookKey: "workbook://worker-retry",
  });

  assert.equal(spawnCount, 2);
});

test("损坏 envelope 或无效解密内容不会返回恢复数据", async (t) => {
  const store = await createStore(t);
  await writeFile(store.recoveryPath, "{not-json", "utf8");
  assert.deepEqual(await store.restore({ workbookKey: "workbook://invalid" }), { status: "unavailable" });
  await assert.rejects(() => readFile(store.recoveryPath, "utf8"), { code: "ENOENT" });

  await writeFile(
    store.recoveryPath,
    JSON.stringify({ version: 1, ciphertext: encode("{not-json") }),
    "utf8",
  );
  assert.deepEqual(await store.restore({ workbookKey: "workbook://invalid" }), { status: "unavailable" });
  await assert.rejects(() => readFile(store.recoveryPath, "utf8"), { code: "ENOENT" });
});

test("无法解密时不降级为明文且将缓存视为不可用", async (t) => {
  const store = await createStore(t, {
    unprotect: async () => {
      throw new Error("DPAPI unavailable");
    },
  });
  await writeFile(
    store.recoveryPath,
    JSON.stringify({ version: 1, ciphertext: "opaque-ciphertext" }),
    "utf8",
  );

  assert.deepEqual(await store.restore({ workbookKey: "workbook://unavailable" }), { status: "unavailable" });
  assert.equal((await readFile(store.recoveryPath, "utf8")).includes("opaque-ciphertext"), true);
});

test("显式清除在 DPAPI 暂不可用时仍删除加密恢复文件", async (t) => {
  const store = await createStore(t, {
    unprotect: async () => {
      throw new Error("DPAPI unavailable");
    },
  });
  await writeFile(
    store.recoveryPath,
    JSON.stringify({ version: 1, ciphertext: "opaque-ciphertext" }),
    "utf8",
  );

  assert.deepEqual(
    await store.clear({ sessionId: "session-unavailable-clear", workbookKey: "workbook://clear" }),
    { status: "cleared" },
  );
  await assert.rejects(() => readFile(store.recoveryPath, "utf8"), { code: "ENOENT" });
});

test("超出大小限制或加密失败时不会留下明文恢复文件", async (t) => {
  const oversized = await createStore(t, { maxBytes: 200 });
  await assert.rejects(
    () => oversized.save({
      sessionId: "session-large-01",
      workbookKey: "workbook://large",
      snapshot: { text: "x".repeat(1_000) },
    }),
    (error) => error instanceof ConversationRecoveryStoreError && error.code === "RECOVERY_TOO_LARGE",
  );
  await assert.rejects(() => readFile(oversized.recoveryPath, "utf8"), { code: "ENOENT" });

  const encryptionFailed = await createStore(t, {
    protect: async () => {
      throw new Error("DPAPI unavailable");
    },
  });
  await assert.rejects(
    () => encryptionFailed.save({
      sessionId: "session-encrypt-01",
      workbookKey: "workbook://encrypt",
      snapshot: snapshot("不能明文落盘"),
    }),
    (error) => error instanceof ConversationRecoveryStoreError && error.code === "RECOVERY_ENCRYPT_FAILED",
  );
  await assert.rejects(() => readFile(encryptionFailed.recoveryPath, "utf8"), { code: "ENOENT" });
});

test("并发 checkpoint、心跳和新 checkpoint 串行执行，最终保留最新快照", async (t) => {
  let releaseFirstEncryption;
  let firstEncryptionStarted;
  const firstEncryptionReady = new Promise((resolve) => {
    firstEncryptionStarted = resolve;
  });
  const firstEncryptionReleased = new Promise((resolve) => {
    releaseFirstEncryption = resolve;
  });
  let protectCalls = 0;
  const store = await createStore(t, {
    protect: async (plaintext) => {
      protectCalls += 1;
      if (protectCalls === 1) {
        firstEncryptionStarted();
        await firstEncryptionReleased;
      }
      return encode(plaintext);
    },
  });

  const firstSave = store.save({
    sessionId: "session-queue-01",
    workbookKey: "workbook://queue",
    snapshot: snapshot("旧检查点"),
  });
  await firstEncryptionReady;
  const heartbeat = store.touch({
    sessionId: "session-queue-01",
    workbookKey: "workbook://queue",
  });
  const latestSave = store.save({
    sessionId: "session-queue-02",
    workbookKey: "workbook://queue",
    snapshot: snapshot("最新检查点"),
  });

  releaseFirstEncryption();
  await Promise.all([firstSave, heartbeat, latestSave]);
  const restored = await store.restore({ workbookKey: "workbook://queue" });

  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-queue-02");
  assert.equal(restored.snapshot.input[0].content[0].text.includes("最新检查点"), true);
});
