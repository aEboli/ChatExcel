function normalizeEffort(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeEffortArray(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const efforts = [];
  for (const item of value) {
    const effort = normalizeEffort(item);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts;
}

function normalizedChoice(value) {
  if (value === null) return null;
  const effort = normalizeEffort(value);
  return effort === "auto" || effort === "default" ? null : effort;
}

function menuIncludes(menuValues, value) {
  return value !== undefined && menuValues.includes(value);
}

export function normalizeReasoningModel(value) {
  const model = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...model,
    reasoningEfforts: normalizeEffortArray(model.reasoningEfforts),
    compatibleReasoningEfforts: normalizeEffortArray(model.compatibleReasoningEfforts),
    defaultReasoningEffort: normalizedChoice(model.defaultReasoningEffort),
  };
}

export function selectableReasoningEfforts(model) {
  const normalized = normalizeReasoningModel(model);
  return normalized.reasoningEfforts.length > 0
    ? normalized.reasoningEfforts
    : normalized.compatibleReasoningEfforts;
}

export function reasoningEffortMenuValues(model) {
  const normalized = normalizeReasoningModel(model);
  const selectable = selectableReasoningEfforts(normalized);

  if (normalized.reasoningMode === "thinking-toggle") return [null, ...selectable];
  if (normalized.reasoningEfforts.length === 0 && normalized.compatibleReasoningEfforts.length > 0) {
    return [null, ...selectable];
  }
  return selectable;
}

export function reconcileReasoningEffort({
  model,
  selectedEffort,
  configuredModelId,
  configuredEffort,
} = {}) {
  const normalized = normalizeReasoningModel(model);
  const menuValues = reasoningEffortMenuValues(normalized);
  const selected = selectedEffort === undefined ? undefined : normalizedChoice(selectedEffort);
  if (menuIncludes(menuValues, selected)) return selected;

  const defaultEffort = normalized.defaultReasoningEffort;
  if (menuIncludes(menuValues, defaultEffort)) return defaultEffort;

  const configured = configuredEffort === undefined ? undefined : normalizedChoice(configuredEffort);
  if (normalized.id === configuredModelId && menuIncludes(menuValues, configured)) return configured;

  if (normalized.reasoningEfforts.length === 0 && normalized.compatibleReasoningEfforts.length > 0) {
    return null;
  }
  return selectableReasoningEfforts(normalized)[0] ?? null;
}

export function reasoningEffortDisplayName(effort) {
  const raw = typeof effort === "string" ? effort.trim() : "";
  const value = normalizedChoice(effort);
  if (value === null) return "自动";
  if (value === "none" || value === "off" || value === "disabled") return "关闭";
  if (value === "minimal" || value === "min") return "最低";
  if (value === "low" || value === "small") return "低";
  if (value === "medium" || value === "med" || value === "balanced") return "中";
  if (value === "high" || value === "large") return "高";
  if (value === "xhigh" || value === "ultra" || value === "very-high") return "极高";
  if (value === "max") return "最高";
  return raw || "自动";
}

export function reasoningEffortLevel(effort) {
  const value = normalizedChoice(effort);
  if (value === null || value === "none" || value === "off" || value === "disabled") return "0";
  if (value === "minimal" || value === "min") return "1";
  if (value === "low" || value === "small") return "2";
  if (value === "medium" || value === "med" || value === "balanced") return "3";
  if (value === "high" || value === "large") return "4";
  if (value === "xhigh" || value === "ultra" || value === "very-high") return "5";
  if (value === "max") return "6";
  return "3";
}
