import { ConversationRecoveryStore } from "./conversation-recovery-store.js";

const [recoveryPath, ttlArgument, initialDeadlineArgument] = process.argv.slice(2);
const ttlMs = Number(ttlArgument);
const initialDeadline = Number(initialDeadlineArgument);

if (
  typeof recoveryPath !== "string" ||
  recoveryPath.trim() === "" ||
  !Number.isSafeInteger(ttlMs) ||
  ttlMs <= 0 ||
  !Number.isSafeInteger(initialDeadline) ||
  initialDeadline <= 0
) {
  process.exitCode = 1;
} else {
  const store = new ConversationRecoveryStore({
    recoveryPath,
    ttlMs,
    cleanupWorkerEnabled: false,
  });

  let sawRecoveryFile = false;
  while (true) {
    let result;
    try {
      result = await store.cleanupExpired();
    } catch {
      result = { status: "unavailable" };
    }

    if (["active", "pending", "unavailable"].includes(result.status)) {
      sawRecoveryFile = true;
      const expiresAt = Number.isSafeInteger(result.expiresAt)
        ? result.expiresAt
        : Date.now() + 60_000;
      const delayMs = Math.max(1_000, Math.min(60_000, expiresAt - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (result.status === "missing" && !sawRecoveryFile && Date.now() < initialDeadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, initialDeadline - Date.now())));
      continue;
    }
    break;
  }
}
