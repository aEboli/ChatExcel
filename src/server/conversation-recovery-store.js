import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
    return this.#enqueue(async () => {
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
  }

  async touch({ sessionId, workbookKey } = {}) {
    return this.#enqueue(async () => {
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
      if (read.status !== "available") {
        if (read.status === "unavailable") {
          return (await this.#removeFile()) ? { status: "cleared" } : { status: "missing" };
        }
        return read;
      }
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
    return this.#enqueue(async () => {
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
  }

  #enqueue(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => {});
    return result;
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
