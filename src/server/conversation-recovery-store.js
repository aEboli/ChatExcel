import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  protectWithWindowsDpapi,
  unprotectWithWindowsDpapi,
} from "./settings-store.js";

export const DEFAULT_CONVERSATION_RECOVERY_PATH = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "ChatExcel",
  "conversation-recovery.json",
);
export const DEFAULT_RECOVERY_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_RECOVERY_MAX_BYTES = 16 * 1024 * 1024;

const ENVELOPE_VERSION = 1;
const MAX_JSON_DEPTH = 100;
const RECOVERY_LOCK_VERSION = 1;
const RECOVERY_LOCK_OWNER_PREFIX = "owner-";
const RECOVERY_LOCK_OWNER_SUFFIX = ".json";
const RECOVERY_LOCK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_RECOVERY_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_RECOVERY_LOCK_RETRY_MS = 25;
const DEFAULT_RECOVERY_LOCK_STALE_MS = 5 * 60 * 1_000;
const DEFAULT_CLEANUP_WORKER_PATH = fileURLToPath(
  new URL("./conversation-recovery-cleanup.js", import.meta.url),
);

export class ConversationRecoveryStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ConversationRecoveryStoreError";
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value, name, maxLength = 512) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new ConversationRecoveryStoreError(
      "RECOVERY_INVALID",
      `${name} 必须是长度受限的非空字符串。`,
    );
  }
  return value.trim();
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数。`);
  }
  return value;
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConversationRecoveryStoreError("RECOVERY_INVALID", `${name} 必须是有效时间戳。`);
  }
  return value;
}

function cloneJsonValue(value, path = "$", depth = 0, seen = new Set()) {
  if (depth > MAX_JSON_DEPTH) {
    throw new ConversationRecoveryStoreError("RECOVERY_INVALID", "恢复快照嵌套层级过深。");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConversationRecoveryStoreError("RECOVERY_INVALID", `${path} 包含非有限数字。`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new ConversationRecoveryStoreError("RECOVERY_INVALID", `${path} 不是可 JSON 序列化的值。`);
  }
  if (seen.has(value)) {
    throw new ConversationRecoveryStoreError("RECOVERY_INVALID", `${path} 包含循环引用。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new ConversationRecoveryStoreError("RECOVERY_INVALID", `${path} 不是普通对象。`);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, depth + 1, seen));
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneJsonValue(item, `${path}.${key}`, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function parseRecord(value) {
  if (!isObject(value) || value.version !== ENVELOPE_VERSION) return null;
  const lastPaneHeartbeatAt = Number.isSafeInteger(value.lastPaneHeartbeatAt)
    ? value.lastPaneHeartbeatAt
    : value.lastActiveAt;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.trim() === "" ||
    typeof value.workbookKey !== "string" ||
    value.workbookKey.trim() === "" ||
    !Number.isSafeInteger(value.lastActiveAt) ||
    value.lastActiveAt < 0 ||
    !Number.isSafeInteger(lastPaneHeartbeatAt) ||
    lastPaneHeartbeatAt < 0 ||
    !isObject(value.snapshot)
  ) {
    return null;
  }
  try {
    return {
      version: ENVELOPE_VERSION,
      sessionId: value.sessionId.trim(),
      workbookKey: value.workbookKey.trim(),
      lastActiveAt: value.lastActiveAt,
      // Old records used the generic activity timestamp for expiry. Keep that
      // short-lived cache readable once, then write the explicit pane lease.
      lastPaneHeartbeatAt,
      snapshot: cloneJsonValue(value.snapshot),
    };
  } catch {
    return null;
  }
}

function envelopeSizeLimit(maxBytes) {
  // DPAPI returns binary data encoded as base64, plus a small JSON envelope.
  return (maxBytes * 2) + (64 * 1024);
}

function unavailableResult(extra = {}) {
  const result = { status: "unavailable" };
  if (Number.isSafeInteger(extra.lastModifiedAt)) {
    Object.defineProperty(result, "lastModifiedAt", {
      value: extra.lastModifiedAt,
      enumerable: false,
    });
  }
  return result;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function waitForLock(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function removeDirectoryWhenEmpty(path, { attempts = 4, retryMs = 5 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rmdir(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      if (
        !["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code) ||
        attempt === attempts - 1
      ) {
        return false;
      }
      await waitForLock(retryMs);
    }
  }
  return false;
}

function parseRecoveryLockOwner(source) {
  let record;
  try {
    record = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !isObject(record) ||
    record.version !== RECOVERY_LOCK_VERSION ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.token !== "string" ||
    !RECOVERY_LOCK_TOKEN_PATTERN.test(record.token) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    return null;
  }
  return record;
}

function recoveryLockOwnerFile(token) {
  return RECOVERY_LOCK_TOKEN_PATTERN.test(token)
    ? `${RECOVERY_LOCK_OWNER_PREFIX}${token}${RECOVERY_LOCK_OWNER_SUFFIX}`
    : null;
}

function isRecoveryLockOwnerFile(name) {
  return typeof name === "string" &&
    name.startsWith(RECOVERY_LOCK_OWNER_PREFIX) &&
    name.endsWith(RECOVERY_LOCK_OWNER_SUFFIX);
}

export class ConversationRecoveryStore {
  constructor({
    recoveryPath = DEFAULT_CONVERSATION_RECOVERY_PATH,
    protect = protectWithWindowsDpapi,
    unprotect = unprotectWithWindowsDpapi,
    now = () => Date.now(),
    ttlMs = DEFAULT_RECOVERY_TTL_MS,
    maxBytes = DEFAULT_RECOVERY_MAX_BYTES,
    cleanupWorkerEnabled = false,
    cleanupWorkerPath = DEFAULT_CLEANUP_WORKER_PATH,
    nodeExecutable = process.execPath,
    spawnProcess = spawn,
    lockTimeoutMs = DEFAULT_RECOVERY_LOCK_TIMEOUT_MS,
    lockRetryMs = DEFAULT_RECOVERY_LOCK_RETRY_MS,
    lockStaleMs = DEFAULT_RECOVERY_LOCK_STALE_MS,
    isLockOwnerAlive = isProcessAlive,
  } = {}) {
    if (typeof recoveryPath !== "string" || recoveryPath.trim() === "") {
      throw new TypeError("recoveryPath 必须是非空路径。");
    }
    if (typeof protect !== "function" || typeof unprotect !== "function") {
      throw new TypeError("ConversationRecoveryStore 需要 DPAPI 保护函数。");
    }
    if (typeof now !== "function") throw new TypeError("now 必须是函数。");
    if (typeof cleanupWorkerEnabled !== "boolean") {
      throw new TypeError("cleanupWorkerEnabled 必须是布尔值。");
    }
    if (typeof cleanupWorkerPath !== "string" || cleanupWorkerPath.trim() === "") {
      throw new TypeError("cleanupWorkerPath 必须是非空路径。");
    }
    if (typeof nodeExecutable !== "string" || nodeExecutable.trim() === "") {
      throw new TypeError("nodeExecutable 必须是非空路径。");
    }
    if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess 必须是函数。");
    if (typeof isLockOwnerAlive !== "function") throw new TypeError("isLockOwnerAlive 必须是函数。");
    this.recoveryPath = recoveryPath;
    this.protect = protect;
    this.unprotect = unprotect;
    this.now = now;
    this.ttlMs = assertPositiveInteger(ttlMs, "ttlMs");
    this.maxBytes = assertPositiveInteger(maxBytes, "maxBytes");
    this.maxEnvelopeBytes = envelopeSizeLimit(this.maxBytes);
    this.cleanupWorkerEnabled = cleanupWorkerEnabled;
    this.cleanupWorkerPath = cleanupWorkerPath;
    this.nodeExecutable = nodeExecutable;
    this.spawnProcess = spawnProcess;
    this.cleanupWorker = null;
    this.writeQueue = Promise.resolve();
    this.lockPath = `${recoveryPath}.lock`;
    this.lockReclaimPath = `${this.lockPath}.reclaim`;
    this.lockReclaimMigrationPath = `${this.lockReclaimPath}.migration`;
    this.lockTimeoutMs = assertPositiveInteger(lockTimeoutMs, "lockTimeoutMs");
    this.lockRetryMs = assertPositiveInteger(lockRetryMs, "lockRetryMs");
    this.lockStaleMs = assertPositiveInteger(lockStaleMs, "lockStaleMs");
    this.isLockOwnerAlive = isLockOwnerAlive;
  }

  async save({ sessionId, workbookKey, snapshot, lastPaneHeartbeatAt } = {}) {
    return this.#enqueue(async () => {
      const record = this.#makeRecord({
        sessionId,
        workbookKey,
        snapshot,
        lastPaneHeartbeatAt,
      });
      this.#ensureCleanupWorker();
      await this.#writeRecord(record);
      return {
        status: "saved",
        sessionId: record.sessionId,
        workbookKey: record.workbookKey,
        lastActiveAt: record.lastActiveAt,
        lastPaneHeartbeatAt: record.lastPaneHeartbeatAt,
        expiresAt: record.lastPaneHeartbeatAt + this.ttlMs,
      };
    });
  }

  async restore({ workbookKey } = {}) {
    try {
      return await this.#enqueue(async () => {
        const expectedWorkbookKey = assertNonEmptyString(workbookKey, "workbookKey");
        const read = await this.#readRecord();
        if (read.status !== "available") return read;
        if (this.#isExpired(read.record)) {
          await this.#discardInvalidOrExpired();
          return { status: "expired" };
        }
        if (read.record.workbookKey !== expectedWorkbookKey) return { status: "mismatch" };
        return {
          status: "available",
          sessionId: read.record.sessionId,
          workbookKey: read.record.workbookKey,
          lastActiveAt: read.record.lastActiveAt,
          lastPaneHeartbeatAt: read.record.lastPaneHeartbeatAt,
          expiresAt: read.record.lastPaneHeartbeatAt + this.ttlMs,
          snapshot: cloneJsonValue(read.record.snapshot),
        };
      });
    } catch (error) {
      if (error?.code === "RECOVERY_LOCK_UNAVAILABLE") return unavailableResult();
      throw error;
    }
  }

  async touch({ sessionId, workbookKey } = {}) {
    try {
      return await this.#enqueue(async () => {
        const expectedSessionId = assertNonEmptyString(sessionId, "sessionId", 160);
        const expectedWorkbookKey = assertNonEmptyString(workbookKey, "workbookKey");
        const read = await this.#readRecord();
        if (read.status !== "available") return read;
        if (this.#isExpired(read.record)) {
          await this.#discardInvalidOrExpired();
          return { status: "expired" };
        }
        if (
          read.record.sessionId !== expectedSessionId ||
          read.record.workbookKey !== expectedWorkbookKey
        ) {
          return { status: "mismatch" };
        }
        const now = this.#now();
        read.record.lastActiveAt = now;
        read.record.lastPaneHeartbeatAt = now;
        this.#ensureCleanupWorker();
        await this.#writeRecord(read.record);
        return {
          status: "touched",
          sessionId: read.record.sessionId,
          workbookKey: read.record.workbookKey,
          lastActiveAt: read.record.lastActiveAt,
          lastPaneHeartbeatAt: read.record.lastPaneHeartbeatAt,
          expiresAt: read.record.lastPaneHeartbeatAt + this.ttlMs,
        };
      });
    } catch (error) {
      if (error?.code === "RECOVERY_LOCK_UNAVAILABLE") return unavailableResult();
      throw error;
    }
  }

  async clear({ sessionId, workbookKey } = {}) {
    return this.#enqueue(async () => {
      const hasSessionId = sessionId !== undefined && sessionId !== null;
      const hasWorkbookKey = workbookKey !== undefined && workbookKey !== null;
      const expectedSessionId = hasSessionId
        ? assertNonEmptyString(sessionId, "sessionId", 160)
        : null;
      const expectedWorkbookKey = hasWorkbookKey
        ? assertNonEmptyString(workbookKey, "workbookKey")
        : null;

      if (!hasSessionId && !hasWorkbookKey) {
        return (await this.#removeFile()) ? { status: "cleared" } : { status: "missing" };
      }

      const read = await this.#readRecord();
      if (read.status !== "available") return read;
      if (
        (expectedSessionId !== null && read.record.sessionId !== expectedSessionId) ||
        (expectedWorkbookKey !== null && read.record.workbookKey !== expectedWorkbookKey)
      ) {
        return { status: "mismatch" };
      }
      return (await this.#removeFile()) ? { status: "cleared" } : { status: "missing" };
    });
  }

  async cleanupExpired() {
    try {
      return await this.#enqueue(async () => {
        const read = await this.#readRecord();
        const temporaryCutoff = this.#now() - this.ttlMs;
        if (read.status === "unavailable") {
          if (
            Number.isSafeInteger(read.lastModifiedAt) &&
            read.lastModifiedAt <= temporaryCutoff
          ) {
            await this.#discardInvalidOrExpired();
            return { status: "expired" };
          }
          await this.#removeTemporaryFiles({ olderThan: temporaryCutoff });
          return {
            ...read,
            ...(Number.isSafeInteger(read.lastModifiedAt)
              ? { expiresAt: read.lastModifiedAt + this.ttlMs }
              : {}),
          };
        }
        if (read.status !== "available") {
          await this.#removeTemporaryFiles({ olderThan: temporaryCutoff });
          if (read.status === "missing") {
            const lastTemporaryWriteAt = await this.#lastTemporaryWriteAt();
            if (lastTemporaryWriteAt !== null) {
              return {
                status: "pending",
                expiresAt: lastTemporaryWriteAt + this.ttlMs,
              };
            }
          }
          return read;
        }
        if (!this.#isExpired(read.record)) {
          await this.#removeTemporaryFiles({ olderThan: temporaryCutoff });
          return {
            status: "active",
            sessionId: read.record.sessionId,
            workbookKey: read.record.workbookKey,
            expiresAt: read.record.lastPaneHeartbeatAt + this.ttlMs,
          };
        }
        await this.#discardInvalidOrExpired();
        return { status: "expired" };
      });
    } catch (error) {
      if (error?.code === "RECOVERY_LOCK_UNAVAILABLE") return unavailableResult();
      throw error;
    }
  }

  #enqueue(operation) {
    const run = () => this.#withRecoveryLock(operation);
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async #withRecoveryLock(operation) {
    const lock = await this.#acquireRecoveryLock();
    let result;
    let operationError;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    const released = await this.#releaseRecoveryLock(lock);
    if (operationError) throw operationError;
    if (!released) {
      throw new ConversationRecoveryStoreError(
        "RECOVERY_LOCK_UNAVAILABLE",
        "无法释放本地恢复快照锁。",
      );
    }
    return result;
  }

  async #acquireRecoveryLock() {
    await mkdir(dirname(this.lockPath), { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;

    while (true) {
      if (await this.#hasActiveRecoveryReclaim()) {
        if (Date.now() >= deadline) {
          throw new ConversationRecoveryStoreError(
            "RECOVERY_LOCK_UNAVAILABLE",
            "本地恢复快照正在由另一个进程处理。",
          );
        }
        await waitForLock(this.lockRetryMs);
        continue;
      }

      let lock;
      try {
        lock = await this.#createAtomicLockDirectory(this.lockPath, token);
      } catch (error) {
        throw new ConversationRecoveryStoreError(
          "RECOVERY_LOCK_UNAVAILABLE",
          "无法取得本地恢复快照锁。",
          { cause: error },
        );
      }

      if (lock) {
        // A reclaimer can begin after the first check and before publication.
        // Do not let a new holder run while it is removing a stale lock.
        if (!(await this.#hasActiveRecoveryReclaim())) return lock;
        if (!(await this.#releaseOwnedLockDirectoryWithRetry(this.lockPath, lock))) {
          throw new ConversationRecoveryStoreError(
            "RECOVERY_LOCK_UNAVAILABLE",
            "无法释放本地恢复快照锁。",
          );
        }
      } else {
        await this.#recoverStaleRecoveryLock();
      }

      if (Date.now() >= deadline) {
        throw new ConversationRecoveryStoreError(
          "RECOVERY_LOCK_UNAVAILABLE",
          "本地恢复快照正在由另一个进程处理。",
        );
      }
      await waitForLock(this.lockRetryMs);
    }
  }

  async #releaseRecoveryLock(lock) {
    return this.#releaseOwnedLockDirectoryWithRetry(this.lockPath, lock);
  }

  async #createAtomicLockDirectory(targetPath, token) {
    const ownerFile = recoveryLockOwnerFile(token);
    if (!ownerFile) {
      throw new ConversationRecoveryStoreError("RECOVERY_LOCK_UNAVAILABLE", "恢复快照锁令牌无效。");
    }
    const lock = { token, ownerFile };
    const candidatePath = `${targetPath}.candidate.${process.pid}.${token}.${randomUUID()}`;
    let published = false;
    try {
      await mkdir(candidatePath);
      await writeFile(join(candidatePath, ownerFile), JSON.stringify({
        version: RECOVERY_LOCK_VERSION,
        pid: process.pid,
        token,
        createdAt: Date.now(),
      }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      if ((await this.#readRecoveryLock(targetPath)).kind !== "missing") return null;
      try {
        await rename(candidatePath, targetPath);
        published = true;
        return lock;
      } catch (error) {
        if ((await this.#readRecoveryLock(targetPath)).kind !== "missing") return null;
        throw error;
      }
    } finally {
      if (!published) await this.#discardCandidateLockDirectory(candidatePath, lock);
    }
  }

  async #discardCandidateLockDirectory(path, lock) {
    await unlink(join(path, lock.ownerFile)).catch(() => {});
    await removeDirectoryWhenEmpty(path);
  }

  async #releaseOwnedLockDirectory(path, lock) {
    try {
      await unlink(join(path, lock.ownerFile));
    } catch {
      return false;
    }
    return removeDirectoryWhenEmpty(path);
  }

  async #releaseOwnedLockDirectoryWithRetry(path, lock) {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      if (await this.#releaseOwnedLockDirectory(path, lock)) return true;

      const current = await this.#readRecoveryLock(path);
      if (current.kind === "missing") return true;
      if (current.kind === "empty-directory") {
        if (await removeDirectoryWhenEmpty(path)) return true;
      } else if (current.kind !== "unavailable" && !this.#isRecoveryLockOwnedBy(lock, current)) {
        return true;
      }

      if (Date.now() >= deadline) return false;
      await waitForLock(this.lockRetryMs);
    }
  }

  async #readRecoveryLock(path) {
    let details;
    try {
      details = await stat(path);
    } catch (error) {
      return error?.code === "ENOENT" ? { kind: "missing" } : { kind: "unavailable" };
    }

    if (details.isDirectory()) {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return { kind: "unavailable", details };
      }
      if (entries.length === 0) return { kind: "empty-directory", details };
      if (entries.length !== 1 || !entries[0].isFile()) return { kind: "unavailable", details };

      const ownerFile = entries[0].name;
      const legacy = ownerFile === "owner.json";
      if (!legacy && !isRecoveryLockOwnerFile(ownerFile)) {
        return { kind: "unavailable", details };
      }
      try {
        const record = parseRecoveryLockOwner(await readFile(join(path, ownerFile), "utf8"));
        if (!record || (!legacy && recoveryLockOwnerFile(record.token) !== ownerFile)) {
          return { kind: "unavailable", details };
        }
        return {
          kind: legacy ? "legacy-directory" : "directory",
          details,
          record,
          ownerFile,
        };
      } catch {
        return { kind: "unavailable", details };
      }
    }
    if (!details.isFile()) return { kind: "unavailable", details };
    try {
      const record = parseRecoveryLockOwner(await readFile(path, "utf8"));
      return record
        ? { kind: "legacy-file", details, record }
        : { kind: "unavailable", details };
    } catch {
      return { kind: "unavailable", details };
    }
  }

  async #hasActiveRecoveryReclaim() {
    if (await this.#hasActiveRecoveryLock(this.lockReclaimMigrationPath)) return true;

    const reclaim = await this.#readRecoveryLock(this.lockReclaimPath);
    if (reclaim.kind !== "legacy-file") {
      return this.#hasActiveRecoveryLock(this.lockReclaimPath, reclaim);
    }
    if (!this.#isRecoveryLockStale(reclaim) || !reclaim.record) return true;
    try {
      if (await this.#isRecoveryLockOwnerAlive(reclaim.record)) return true;
    } catch {
      return true;
    }
    return !(await this.#migrateStaleLegacyRecoveryReclaim(reclaim));
  }

  async #hasActiveRecoveryLock(path, lock = null) {
    const current = lock ?? await this.#readRecoveryLock(path);
    if (current.kind === "missing") return false;
    if (!this.#isRecoveryLockStale(current)) return true;
    if (current.kind === "empty-directory") {
      return !(await removeDirectoryWhenEmpty(path));
    }
    if (
      (current.kind !== "directory" && current.kind !== "legacy-directory") ||
      !current.record
    ) {
      return true;
    }
    try {
      if (await this.#isRecoveryLockOwnerAlive(current.record)) return true;
    } catch {
      return true;
    }
    return !(await this.#releaseOwnedLockDirectoryWithRetry(path, current));
  }

  async #acquireRecoveryReclaim() {
    if (await this.#hasActiveRecoveryReclaim()) return null;
    try {
      return await this.#createAtomicLockDirectory(this.lockReclaimPath, randomUUID());
    } catch {
      return null;
    }
  }

  async #releaseRecoveryReclaim(reclaim) {
    return this.#releaseOwnedLockDirectoryWithRetry(this.lockReclaimPath, reclaim);
  }

  async #migrateStaleLegacyRecoveryReclaim(reclaim) {
    let migration;
    try {
      migration = await this.#createAtomicLockDirectory(
        this.lockReclaimMigrationPath,
        randomUUID(),
      );
    } catch {
      return false;
    }
    if (!migration) return false;

    let migrated = false;
    try {
      const current = await this.#readRecoveryLock(this.lockReclaimPath);
      if (
        current.kind !== "legacy-file" ||
        !this.#isSameRecoveryLock(reclaim, current) ||
        !this.#isRecoveryLockStale(current) ||
        !current.record
      ) {
        return false;
      }
      try {
        if (await this.#isRecoveryLockOwnerAlive(current.record)) return false;
      } catch {
        return false;
      }
      migrated = await this.#quarantineLegacyLockFile(this.lockReclaimPath, current);
    } finally {
      if (!(await this.#releaseOwnedLockDirectoryWithRetry(this.lockReclaimMigrationPath, migration))) {
        throw new ConversationRecoveryStoreError(
          "RECOVERY_LOCK_UNAVAILABLE",
          "无法释放本地恢复快照旧标记迁移锁。",
        );
      }
    }
    return migrated;
  }

  async #recoverStaleRecoveryLock() {
    const stale = await this.#readRecoveryLock(this.lockPath);
    if (!this.#isRecoveryLockStale(stale)) return false;

    if (
      stale.kind !== "empty-directory" &&
      stale.kind !== "directory" &&
      stale.kind !== "legacy-directory" &&
      stale.kind !== "legacy-file"
    ) {
      return false;
    }

    if (stale.kind !== "empty-directory") {
      if (!stale.record) return false;
      try {
        if (await this.#isRecoveryLockOwnerAlive(stale.record)) return false;
      } catch {
        return false;
      }
    }

    const reclaim = await this.#acquireRecoveryReclaim();
    if (!reclaim) return false;
    let recovered = false;
    try {
      const current = await this.#readRecoveryLock(this.lockPath);
      if (!this.#isSameRecoveryLock(stale, current) || !this.#isRecoveryLockStale(current)) return false;
      recovered = await (current.kind === "empty-directory"
        ? removeDirectoryWhenEmpty(this.lockPath)
        : current.kind === "legacy-file"
          ? this.#quarantineLegacyLockFile(this.lockPath, current)
          : this.#releaseOwnedLockDirectoryWithRetry(this.lockPath, current));
    } finally {
      if (!(await this.#releaseRecoveryReclaim(reclaim))) {
        throw new ConversationRecoveryStoreError(
          "RECOVERY_LOCK_UNAVAILABLE",
          "无法释放本地恢复快照回收锁。",
        );
      }
    }
    return recovered;
  }

  #isRecoveryLockStale(lock) {
    return Number.isFinite(lock?.details?.mtimeMs) &&
      Date.now() - lock.details.mtimeMs >= this.lockStaleMs;
  }

  #isSameRecoveryLock(left, right) {
    if (left?.kind !== right?.kind) return false;
    if (left?.kind === "empty-directory") return true;
    return left?.ownerFile === right?.ownerFile &&
      left?.record?.token === right?.record?.token &&
      left?.record?.pid === right?.record?.pid &&
      left?.record?.createdAt === right?.record?.createdAt;
  }

  #isRecoveryLockOwnedBy(lock, current) {
    return (
      (current?.kind === "directory" || current?.kind === "legacy-directory") &&
      current.ownerFile === lock?.ownerFile &&
      current.record?.token === lock?.token
    );
  }

  async #isRecoveryLockOwnerAlive(record) {
    if (record.pid === process.pid) return true;
    return this.isLockOwnerAlive(record.pid);
  }

  async #quarantineLegacyLockFile(path, lock) {
    const quarantinePath = `${path}.legacy.${process.pid}.${lock.record.token}.${randomUUID()}`;
    try {
      await rename(path, quarantinePath);
    } catch {
      return false;
    }
    await unlink(quarantinePath).catch(() => {});
    return true;
  }

  #now() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ConversationRecoveryStoreError("RECOVERY_CLOCK_INVALID", "恢复时钟返回了无效时间。");
    }
    return value;
  }

  #makeRecord({ sessionId, workbookKey, snapshot, lastPaneHeartbeatAt }) {
    const normalizedSnapshot = cloneJsonValue(snapshot);
    if (!isObject(normalizedSnapshot)) {
      throw new ConversationRecoveryStoreError("RECOVERY_INVALID", "恢复快照必须是对象。");
    }
    const now = this.#now();
    const normalizedPaneHeartbeatAt = lastPaneHeartbeatAt === undefined
      ? now
      : assertTimestamp(lastPaneHeartbeatAt, "lastPaneHeartbeatAt");
    return {
      version: ENVELOPE_VERSION,
      sessionId: assertNonEmptyString(sessionId, "sessionId", 160),
      workbookKey: assertNonEmptyString(workbookKey, "workbookKey"),
      lastActiveAt: now,
      lastPaneHeartbeatAt: normalizedPaneHeartbeatAt,
      snapshot: normalizedSnapshot,
    };
  }

  #isExpired(record) {
    return record.lastPaneHeartbeatAt <= this.#now() - this.ttlMs;
  }

  #ensureCleanupWorker() {
    if (!this.cleanupWorkerEnabled || this.cleanupWorker) return;
    try {
      const initialDeadline = this.#now() + this.ttlMs;
      const child = this.spawnProcess(
        this.nodeExecutable,
        [this.cleanupWorkerPath, this.recoveryPath, String(this.ttlMs), String(initialDeadline)],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      this.cleanupWorker = child;
      const clearCleanupWorker = () => {
        if (this.cleanupWorker === child) this.cleanupWorker = null;
      };
      child?.once?.("error", clearCleanupWorker);
      child?.once?.("exit", clearCleanupWorker);
      child?.unref?.();
    } catch {
      // The in-process sweep still enforces expiry while the local service is alive.
    }
  }

  async #readRecord() {
    let source;
    let lastModifiedAt = null;
    try {
      const details = await stat(this.recoveryPath);
      lastModifiedAt = Math.floor(details.mtimeMs);
      if (details.size > this.maxEnvelopeBytes) {
        await this.#discardInvalidOrExpired();
        return unavailableResult();
      }
      source = await readFile(this.recoveryPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" };
      return unavailableResult();
    }

    let envelope;
    try {
      envelope = JSON.parse(source);
    } catch {
      await this.#discardInvalidOrExpired();
      return unavailableResult({ lastModifiedAt });
    }
    if (
      !isObject(envelope) ||
      envelope.version !== ENVELOPE_VERSION ||
      typeof envelope.ciphertext !== "string" ||
      envelope.ciphertext.trim() === ""
    ) {
      await this.#discardInvalidOrExpired();
      return unavailableResult({ lastModifiedAt });
    }

    let plaintext;
    try {
      plaintext = await this.unprotect(envelope.ciphertext);
    } catch {
      // DPAPI can be temporarily unavailable; retaining the encrypted file is safer than deleting it.
      return unavailableResult({ lastModifiedAt });
    }
    if (typeof plaintext !== "string" || Buffer.byteLength(plaintext, "utf8") > this.maxBytes) {
      await this.#discardInvalidOrExpired();
      return unavailableResult({ lastModifiedAt });
    }

    let parsed;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      await this.#discardInvalidOrExpired();
      return unavailableResult({ lastModifiedAt });
    }
    const record = parseRecord(parsed);
    if (!record) {
      await this.#discardInvalidOrExpired();
      return unavailableResult({ lastModifiedAt });
    }
    return { status: "available", record };
  }

  async #writeRecord(record) {
    const plaintext = JSON.stringify(record);
    if (Buffer.byteLength(plaintext, "utf8") > this.maxBytes) {
      throw new ConversationRecoveryStoreError(
        "RECOVERY_TOO_LARGE",
        "当前会话恢复快照超过本地安全大小限制。",
      );
    }

    let ciphertext;
    try {
      ciphertext = await this.protect(plaintext);
    } catch (error) {
      throw new ConversationRecoveryStoreError("RECOVERY_ENCRYPT_FAILED", "无法加密本地恢复快照。", {
        cause: error,
      });
    }
    if (typeof ciphertext !== "string" || ciphertext.trim() === "") {
      throw new ConversationRecoveryStoreError("RECOVERY_ENCRYPT_FAILED", "无法加密本地恢复快照。");
    }
    const envelope = JSON.stringify({ version: ENVELOPE_VERSION, ciphertext });
    if (Buffer.byteLength(envelope, "utf8") > this.maxEnvelopeBytes) {
      throw new ConversationRecoveryStoreError(
        "RECOVERY_TOO_LARGE",
        "当前会话恢复快照超过本地安全大小限制。",
      );
    }

    await mkdir(dirname(this.recoveryPath), { recursive: true });
    const temporaryPath = `${this.recoveryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // The temporary file contains only the encrypted envelope, never snapshot plaintext.
      await writeFile(temporaryPath, `${envelope}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.recoveryPath);
    } catch (error) {
      throw new ConversationRecoveryStoreError("RECOVERY_WRITE_FAILED", "无法写入本地恢复快照。", {
        cause: error,
      });
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }

  async #removeFile() {
    let removed = false;
    try {
      await unlink(this.recoveryPath);
      removed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new ConversationRecoveryStoreError("RECOVERY_CLEAR_FAILED", "无法清除本地恢复快照。", {
          cause: error,
        });
      }
    }
    return (await this.#removeTemporaryFiles()) || removed;
  }

  async #removeTemporaryFiles({ olderThan = null } = {}) {
    const directory = dirname(this.recoveryPath);
    const prefix = `${basename(this.recoveryPath)}.`;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      return false;
    }

    let removed = false;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(".tmp")
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (olderThan !== null) {
        try {
          const details = await stat(path);
          if (details.mtimeMs > olderThan) continue;
        } catch {
          continue;
        }
      }
      try {
        await unlink(path);
        removed = true;
      } catch {
        // A concurrent writer can finish or clean its own temporary envelope.
      }
    }
    return removed;
  }

  async #lastTemporaryWriteAt() {
    const directory = dirname(this.recoveryPath);
    const prefix = `${basename(this.recoveryPath)}.`;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }

    let lastWriteAt = null;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(".tmp")
      ) {
        continue;
      }
      try {
        const details = await stat(join(directory, entry.name));
        const modifiedAt = Math.floor(details.mtimeMs);
        if (Number.isSafeInteger(modifiedAt)) {
          lastWriteAt = lastWriteAt === null ? modifiedAt : Math.max(lastWriteAt, modifiedAt);
        }
      } catch {
        // A concurrent writer can remove its temporary envelope before it is inspected.
      }
    }
    return lastWriteAt;
  }

  async #discardInvalidOrExpired() {
    try {
      await this.#removeFile();
    } catch {
      // An unreadable/corrupt recovery cache must never block the active conversation.
    }
  }
}
