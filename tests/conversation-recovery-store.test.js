import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

function ownerFile(token) {
  return `owner-${token}.json`;
}

async function writeStaleDirectoryLock(lockPath, { token, pid = 999_999, legacy = false } = {}) {
  await mkdir(lockPath);
  const file = legacy ? "owner.json" : ownerFile(token);
  await writeFile(join(lockPath, file), JSON.stringify({
    version: 1,
    pid,
    token,
    createdAt: 1,
  }), "utf8");
  await utimes(lockPath, new Date(1), new Date(1));
  return file;
}

async function lockArtifacts(store) {
  const prefix = `${basename(store.recoveryPath)}.lock`;
  return (await readdir(dirname(store.recoveryPath))).filter((entry) => entry.startsWith(prefix));
}

async function waitFor(assertion, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await assertion()) return;
    if (Date.now() >= deadline) throw new Error("等待受控锁时序超时。");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
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

test("显式清除在 DPAPI 暂不可用时保留无法验证归属的加密恢复文件", async (t) => {
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
    { status: "unavailable" },
  );
  assert.equal((await readFile(store.recoveryPath, "utf8")).includes("opaque-ciphertext"), true);
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

test("跨进程过期清理会等待同一恢复锁，不会删除并发保存的新快照", async (t) => {
  let currentTime = 1_000;
  const initial = await createStore(t, { now: () => currentTime, ttlMs: 100 });
  await initial.save({
    sessionId: "session-stale-01",
    workbookKey: "workbook://lock-race",
    snapshot: snapshot("旧快照"),
  });

  currentTime = 1_100;
  let releaseExpiredRead;
  let expiredReadStarted;
  const expiredReadReady = new Promise((resolve) => {
    expiredReadStarted = resolve;
  });
  const expiredReadRelease = new Promise((resolve) => {
    releaseExpiredRead = resolve;
  });
  const cleanupStore = new ConversationRecoveryStore({
    recoveryPath: initial.recoveryPath,
    protect: async (plaintext) => encode(plaintext),
    unprotect: async (ciphertext) => {
      expiredReadStarted();
      await expiredReadRelease;
      return decode(ciphertext);
    },
    now: () => currentTime,
    ttlMs: 100,
  });
  let writerEntered = false;
  const writerStore = new ConversationRecoveryStore({
    recoveryPath: initial.recoveryPath,
    protect: async (plaintext) => {
      writerEntered = true;
      return encode(plaintext);
    },
    unprotect: async (ciphertext) => decode(ciphertext),
    now: () => currentTime,
    ttlMs: 100,
  });

  const cleanup = cleanupStore.cleanupExpired();
  await expiredReadReady;
  const save = writerStore.save({
    sessionId: "session-fresh-01",
    workbookKey: "workbook://lock-race",
    snapshot: snapshot("新快照"),
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writerEntered, false);

  releaseExpiredRead();
  assert.deepEqual(await cleanup, { status: "expired" });
  await save;

  const restored = await writerStore.restore({ workbookKey: "workbook://lock-race" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-fresh-01");
  assert.equal(restored.snapshot.input[0].content[0].text.includes("新快照"), true);
});

test("延迟的旧锁释放不会删除已重建的新目录锁", async (t) => {
  let releaseOldWrite;
  let oldWriteStarted;
  const oldWriteReady = new Promise((resolve) => {
    oldWriteStarted = resolve;
  });
  const oldWriteReleased = new Promise((resolve) => {
    releaseOldWrite = resolve;
  });
  const oldStore = await createStore(t, {
    lockTimeoutMs: 200,
    lockRetryMs: 5,
    lockStaleMs: 1,
    protect: async (plaintext) => {
      oldWriteStarted();
      await oldWriteReleased;
      return encode(plaintext);
    },
  });

  const oldSave = oldStore.save({
    sessionId: "session-old-owner-01",
    workbookKey: "workbook://owner-release",
    snapshot: snapshot("旧锁持有者"),
  });
  await oldWriteReady;

  const [oldOwnerFile] = await readdir(oldStore.lockPath);
  const oldOwnerPath = join(oldStore.lockPath, oldOwnerFile);
  const oldOwner = JSON.parse(await readFile(oldOwnerPath, "utf8"));
  await writeFile(oldOwnerPath, JSON.stringify({ ...oldOwner, pid: 999_997 }), "utf8");
  await utimes(oldStore.lockPath, new Date(1), new Date(1));

  let releaseNewWrite;
  let newWriteStarted;
  const newWriteReady = new Promise((resolve) => {
    newWriteStarted = resolve;
  });
  const newWriteReleased = new Promise((resolve) => {
    releaseNewWrite = resolve;
  });
  const newStore = new ConversationRecoveryStore({
    recoveryPath: oldStore.recoveryPath,
    protect: async (plaintext) => {
      newWriteStarted();
      await newWriteReleased;
      return encode(plaintext);
    },
    unprotect: async (ciphertext) => decode(ciphertext),
    lockTimeoutMs: 200,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });

  const newSave = newStore.save({
    sessionId: "session-new-owner-01",
    workbookKey: "workbook://owner-release",
    snapshot: snapshot("新锁持有者"),
  });
  await newWriteReady;
  const ownersBeforeOldRelease = await readdir(oldStore.lockPath);
  assert.equal(ownersBeforeOldRelease.length, 1);
  assert.match(ownersBeforeOldRelease[0], /^owner-[A-Za-z0-9_-]+\.json$/);

  releaseOldWrite();
  await oldSave;

  assert.deepEqual(await readdir(oldStore.lockPath), ownersBeforeOldRelease);
  releaseNewWrite();
  await newSave;

  const restored = await newStore.restore({ workbookKey: "workbook://owner-release" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-new-owner-01");
  assert.deepEqual(await lockArtifacts(newStore), []);
});

test("两个实例并发回收陈旧锁时始终保持写入互斥", async (t) => {
  const initial = await createStore(t);
  await writeStaleDirectoryLock(initial.lockPath, { token: "shared-stale-lock" });

  let releaseFirstWrite;
  let firstWriteStarted;
  const firstWriteReady = new Promise((resolve) => {
    firstWriteStarted = resolve;
  });
  const firstWriteReleased = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let holdFirstWrite = true;
  const protect = async (plaintext) => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      if (holdFirstWrite) {
        holdFirstWrite = false;
        firstWriteStarted();
        await firstWriteReleased;
      }
      return encode(plaintext);
    } finally {
      activeWrites -= 1;
    }
  };
  const options = {
    recoveryPath: initial.recoveryPath,
    protect,
    unprotect: async (ciphertext) => decode(ciphertext),
    lockTimeoutMs: 300,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  };
  const first = new ConversationRecoveryStore(options);
  const second = new ConversationRecoveryStore(options);

  const firstSave = first.save({
    sessionId: "session-stale-recovery-first",
    workbookKey: "workbook://concurrent-stale-recovery",
    snapshot: snapshot("第一个回收者"),
  });
  const secondSave = second.save({
    sessionId: "session-stale-recovery-second",
    workbookKey: "workbook://concurrent-stale-recovery",
    snapshot: snapshot("第二个回收者"),
  });
  await firstWriteReady;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(activeWrites, 1);
  assert.equal(maxActiveWrites, 1);
  releaseFirstWrite();
  await Promise.all([firstSave, secondSave]);

  assert.equal(maxActiveWrites, 1);
  const restored = await first.restore({ workbookKey: "workbook://concurrent-stale-recovery" });
  assert.equal(restored.status, "available");
  assert.match(restored.sessionId, /^session-stale-recovery-(first|second)$/);
  assert.deepEqual(await lockArtifacts(first), []);
});

test("释放时目录短暂非空会重试并移除锁目录", async (t) => {
  let releaseWrite;
  let writeStarted;
  const writeReady = new Promise((resolve) => {
    writeStarted = resolve;
  });
  const writeReleased = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const store = await createStore(t, {
    lockTimeoutMs: 200,
    lockRetryMs: 5,
    protect: async (plaintext) => {
      writeStarted();
      await writeReleased;
      return encode(plaintext);
    },
  });

  const save = store.save({
    sessionId: "session-release-retry",
    workbookKey: "workbook://release-retry",
    snapshot: snapshot("目录占用后重试释放"),
  });
  await writeReady;
  const [owner] = await readdir(store.lockPath);
  const blocker = join(store.lockPath, "release-blocker.tmp");
  await writeFile(blocker, "hold", "utf8");
  releaseWrite();

  await waitFor(async () => !(await readdir(store.lockPath)).includes(owner));
  await unlink(blocker);
  await save;

  const restored = await store.restore({ workbookKey: "workbook://release-retry" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-release-retry");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("陈旧 reclaim 目录标记会被 token 专属清理且不阻塞新写入", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 100,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });
  await writeStaleDirectoryLock(store.lockReclaimPath, { token: "stale-reclaim" });

  await store.save({
    sessionId: "session-after-stale-reclaim",
    workbookKey: "workbook://stale-reclaim",
    snapshot: snapshot("陈旧 reclaim 已清理"),
  });

  const restored = await store.restore({ workbookKey: "workbook://stale-reclaim" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-after-stale-reclaim");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("陈旧旧硬链接 reclaim 标记在确认 owner 退出后迁移并允许新写入", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 100,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });
  const owner = { version: 1, pid: 999_996, token: "legacy-reclaim-lock", createdAt: 1 };
  await writeFile(store.lockReclaimPath, JSON.stringify(owner), "utf8");
  await utimes(store.lockReclaimPath, new Date(1), new Date(1));

  await store.save({
    sessionId: "session-after-legacy-reclaim-lock",
    workbookKey: "workbook://legacy-reclaim-lock",
    snapshot: snapshot("旧回收标记已迁移"),
  });

  const restored = await store.restore({ workbookKey: "workbook://legacy-reclaim-lock" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-after-legacy-reclaim-lock");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("活跃旧硬链接 reclaim 标记保持不可用且不会被迁移", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 25,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => true,
  });
  const owner = { version: 1, pid: 999_995, token: "legacy-reclaim-live", createdAt: 1 };
  await writeFile(store.lockReclaimPath, JSON.stringify(owner), "utf8");
  await utimes(store.lockReclaimPath, new Date(1), new Date(1));

  assert.deepEqual(
    await store.restore({ workbookKey: "workbook://legacy-reclaim-lock" }),
    { status: "unavailable" },
  );
  assert.deepEqual(JSON.parse(await readFile(store.lockReclaimPath, "utf8")), owner);
});

test("活跃旧标记迁移锁会阻止新写入且保留旧 reclaim 文件", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 25,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });
  const legacyOwner = { version: 1, pid: 999_994, token: "legacy-reclaim-pending", createdAt: 1 };
  await writeFile(store.lockReclaimPath, JSON.stringify(legacyOwner), "utf8");
  await utimes(store.lockReclaimPath, new Date(1), new Date(1));
  const migrationOwnerFile = await writeStaleDirectoryLock(store.lockReclaimMigrationPath, {
    token: "active-legacy-reclaim-migration",
    pid: process.pid,
  });

  assert.deepEqual(
    await store.restore({ workbookKey: "workbook://legacy-reclaim-pending" }),
    { status: "unavailable" },
  );
  assert.deepEqual(JSON.parse(await readFile(store.lockReclaimPath, "utf8")), legacyOwner);

  await unlink(join(store.lockReclaimMigrationPath, migrationOwnerFile));
  await rmdir(store.lockReclaimMigrationPath);
  await store.save({
    sessionId: "session-after-legacy-reclaim-migration",
    workbookKey: "workbook://legacy-reclaim-pending",
    snapshot: snapshot("迁移锁释放后继续"),
  });
  assert.deepEqual(await lockArtifacts(store), []);
});

test("延迟的旧 reclaim 迁移不会移动新发布的目录标记", async (t) => {
  const legacyOwner = { version: 1, pid: 999_993, token: "legacy-reclaim-delayed", createdAt: 1 };
  let releaseLegacyCheck;
  let legacyCheckStarted;
  const legacyCheckReady = new Promise((resolve) => {
    legacyCheckStarted = resolve;
  });
  const legacyCheckReleased = new Promise((resolve) => {
    releaseLegacyCheck = resolve;
  });
  const store = await createStore(t, {
    lockTimeoutMs: 500,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async (pid) => {
      if (pid === legacyOwner.pid) {
        legacyCheckStarted();
        await legacyCheckReleased;
      }
      return false;
    },
  });
  await writeFile(store.lockReclaimPath, JSON.stringify(legacyOwner), "utf8");
  await utimes(store.lockReclaimPath, new Date(1), new Date(1));

  const save = store.save({
    sessionId: "session-delayed-legacy-reclaim",
    workbookKey: "workbook://delayed-legacy-reclaim",
    snapshot: snapshot("延迟旧标记迁移"),
  });
  await legacyCheckReady;

  await unlink(store.lockReclaimPath);
  const freshOwnerFile = await writeStaleDirectoryLock(store.lockReclaimPath, {
    token: "fresh-reclaim-directory",
    pid: process.pid,
  });
  releaseLegacyCheck();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal((await readdir(store.lockReclaimPath)).includes(freshOwnerFile), true);
  await unlink(join(store.lockReclaimPath, freshOwnerFile));
  await rmdir(store.lockReclaimPath);
  await save;

  const restored = await store.restore({ workbookKey: "workbook://delayed-legacy-reclaim" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-delayed-legacy-reclaim");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("两个实例并发迁移同一陈旧旧 reclaim 标记时保持写入互斥", async (t) => {
  const legacyOwner = { version: 1, pid: 999_992, token: "legacy-reclaim-shared", createdAt: 1 };
  let releaseLegacyChecks;
  let legacyChecksStarted;
  const legacyChecksReady = new Promise((resolve) => {
    legacyChecksStarted = resolve;
  });
  const legacyChecksReleased = new Promise((resolve) => {
    releaseLegacyChecks = resolve;
  });
  let waitingLegacyChecks = 0;
  let holdLegacyChecks = true;
  const isLockOwnerAlive = async (pid) => {
    if (pid === legacyOwner.pid && holdLegacyChecks) {
      waitingLegacyChecks += 1;
      if (waitingLegacyChecks === 2) legacyChecksStarted();
      await legacyChecksReleased;
    }
    return false;
  };
  const initial = await createStore(t);
  await writeFile(initial.lockReclaimPath, JSON.stringify(legacyOwner), "utf8");
  await utimes(initial.lockReclaimPath, new Date(1), new Date(1));

  let releaseFirstWrite;
  let firstWriteStarted;
  const firstWriteReady = new Promise((resolve) => {
    firstWriteStarted = resolve;
  });
  const firstWriteReleased = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let holdFirstWrite = true;
  const protect = async (plaintext) => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      if (holdFirstWrite) {
        holdFirstWrite = false;
        firstWriteStarted();
        await firstWriteReleased;
      }
      return encode(plaintext);
    } finally {
      activeWrites -= 1;
    }
  };
  const options = {
    recoveryPath: initial.recoveryPath,
    protect,
    unprotect: async (ciphertext) => decode(ciphertext),
    lockTimeoutMs: 500,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive,
  };
  const first = new ConversationRecoveryStore(options);
  const second = new ConversationRecoveryStore(options);
  const firstSave = first.save({
    sessionId: "session-shared-legacy-reclaim-first",
    workbookKey: "workbook://shared-legacy-reclaim",
    snapshot: snapshot("第一个旧标记迁移者"),
  });
  const secondSave = second.save({
    sessionId: "session-shared-legacy-reclaim-second",
    workbookKey: "workbook://shared-legacy-reclaim",
    snapshot: snapshot("第二个旧标记迁移者"),
  });
  await legacyChecksReady;
  holdLegacyChecks = false;
  releaseLegacyChecks();
  await firstWriteReady;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(activeWrites, 1);
  assert.equal(maxActiveWrites, 1);
  releaseFirstWrite();
  await Promise.all([firstSave, secondSave]);

  assert.equal(maxActiveWrites, 1);
  const restored = await first.restore({ workbookKey: "workbook://shared-legacy-reclaim" });
  assert.equal(restored.status, "available");
  assert.match(restored.sessionId, /^session-shared-legacy-reclaim-(first|second)$/);
  assert.deepEqual(await lockArtifacts(first), []);
});

test("仅在锁拥有者已确认退出时回收陈旧 token 目录锁", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 100,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });
  const lockPath = `${store.recoveryPath}.lock`;
  await writeStaleDirectoryLock(lockPath, { token: "stale-lock" });

  await store.save({
    sessionId: "session-after-stale-lock",
    workbookKey: "workbook://stale-lock",
    snapshot: snapshot(),
  });

  const restored = await store.restore({ workbookKey: "workbook://stale-lock" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-after-stale-lock");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("陈旧旧版 owner.json 目录锁仍可安全回收", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 100,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });
  await writeStaleDirectoryLock(`${store.recoveryPath}.lock`, {
    token: "legacy-directory-lock",
    legacy: true,
  });

  await store.save({
    sessionId: "session-after-legacy-directory-lock",
    workbookKey: "workbook://legacy-directory-lock",
    snapshot: snapshot(),
  });

  const restored = await store.restore({ workbookKey: "workbook://legacy-directory-lock" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-after-legacy-directory-lock");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("空的陈旧目录锁不会永久阻塞新的恢复快照", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 100,
    lockRetryMs: 5,
    lockStaleMs: 1,
  });
  const lockPath = `${store.recoveryPath}.lock`;
  await mkdir(lockPath);
  await utimes(lockPath, new Date(1), new Date(1));

  await store.save({
    sessionId: "session-after-empty-lock",
    workbookKey: "workbook://empty-lock",
    snapshot: snapshot("空锁已回收"),
  });

  const restored = await store.restore({ workbookKey: "workbook://empty-lock" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-after-empty-lock");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("未过期的空旧锁保持失败关闭且不会修改现有快照", async (t) => {
  const initial = await createStore(t);
  await initial.save({
    sessionId: "session-before-active-empty-lock",
    workbookKey: "workbook://active-empty-lock",
    snapshot: snapshot("保留现有快照"),
  });
  const encryptedBefore = await readFile(initial.recoveryPath, "utf8");
  const lockPath = `${initial.recoveryPath}.lock`;
  await mkdir(lockPath);
  const contender = new ConversationRecoveryStore({
    recoveryPath: initial.recoveryPath,
    protect: async (plaintext) => encode(plaintext),
    unprotect: async (ciphertext) => decode(ciphertext),
    lockTimeoutMs: 25,
    lockRetryMs: 5,
    lockStaleMs: 60_000,
  });

  assert.deepEqual(
    await contender.restore({ workbookKey: "workbook://active-empty-lock" }),
    { status: "unavailable" },
  );
  assert.equal(await readFile(initial.recoveryPath, "utf8"), encryptedBefore);

  await rmdir(lockPath);
  const restored = await initial.restore({ workbookKey: "workbook://active-empty-lock" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-before-active-empty-lock");
});

test("陈旧旧硬链接文件锁在确认 owner 退出后迁移并允许新写入", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 100,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => false,
  });
  const lockPath = `${store.recoveryPath}.lock`;
  const owner = { version: 1, pid: 999_998, token: "legacy-hardlink-lock", createdAt: 1 };
  await writeFile(lockPath, JSON.stringify(owner), "utf8");
  await utimes(lockPath, new Date(1), new Date(1));

  const saved = await store.save({
    sessionId: "session-after-legacy-hardlink-lock",
    workbookKey: "workbook://legacy-hardlink-lock",
    snapshot: snapshot("旧硬链接锁已迁移"),
  });
  assert.equal(saved.status, "saved");

  const restored = await store.restore({ workbookKey: "workbook://legacy-hardlink-lock" });
  assert.equal(restored.status, "available");
  assert.equal(restored.sessionId, "session-after-legacy-hardlink-lock");
  assert.deepEqual(await lockArtifacts(store), []);
});

test("活跃旧硬链接文件锁保持不可用且不会被迁移", async (t) => {
  const store = await createStore(t, {
    lockTimeoutMs: 25,
    lockRetryMs: 5,
    lockStaleMs: 1,
    isLockOwnerAlive: async () => true,
  });
  const lockPath = `${store.recoveryPath}.lock`;
  const owner = { version: 1, pid: 999_998, token: "legacy-hardlink-live", createdAt: 1 };
  await writeFile(lockPath, JSON.stringify(owner), "utf8");
  await utimes(lockPath, new Date(1), new Date(1));

  assert.deepEqual(
    await store.restore({ workbookKey: "workbook://legacy-hardlink-lock" }),
    { status: "unavailable" },
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), owner);
});
