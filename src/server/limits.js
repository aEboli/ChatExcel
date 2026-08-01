export const DEFAULT_MAX_STEPS = 100;
export const MIN_MAX_STEPS = 1;
export const MAX_MAX_STEPS = 1_000;

export function normalizeMaxSteps(value, {
  code = "MAX_STEPS_INVALID",
  message = `最大步骤数必须是 ${MIN_MAX_STEPS} 到 ${MAX_MAX_STEPS} 之间的整数。`,
  ErrorClass = Error,
} = {}) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MAX_STEPS || parsed > MAX_MAX_STEPS) {
    throw new ErrorClass(code, message);
  }
  return parsed;
}
