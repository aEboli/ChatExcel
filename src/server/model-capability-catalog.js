const OPENAI_GPT_5_6_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const OPENAI_GPT_5_5_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh"]);
const PROVIDER_DEFAULT_EFFORTS = Object.freeze([]);
const NO_REASONING_EFFORTS = Object.freeze(["none"]);
const DEEPSEEK_V4_FLASH_EFFORTS = Object.freeze(["none", "low", "high", "max"]);
const DEEPSEEK_V4_PRO_EFFORTS = Object.freeze(["none", "high", "max"]);
const QWEN3_7_MAX_CHAT_EFFORTS = Object.freeze(["none"]);
const QWEN3_7_MAX_RESPONSES_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high"]);
const QWEN3_7_MAX_IDS = Object.freeze([
  "qwen3.7-max",
  "qwen3.7-max-2026-05-20",
  "qwen3.7-max-2026-06-08",
]);
const QWEN3_7_MAX_REFERENCES = Object.freeze([
  "https://help.aliyun.com/zh/model-studio/qwen3-7-max.md",
  "https://help.aliyun.com/zh/model-studio/deep-thinking.md",
]);

function exactModelIds(modelIds) {
  const ids = new Set(modelIds);
  return (modelId) => ids.has(modelId);
}

const OFFICIAL_CAPABILITIES = Object.freeze([
  Object.freeze({
    protocols: Object.freeze(["openai-responses", "openai-chat-completions"]),
    matches: exactModelIds(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    contextWindow: 1_050_000,
    reasoningMode: "levels",
    reasoningEfforts: OPENAI_GPT_5_6_EFFORTS,
    defaultReasoningEffort: "medium",
    references: Object.freeze([
      "https://developers.openai.com/api/docs/models/gpt-5.6-sol.md",
      "https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6.md",
    ]),
  }),
  Object.freeze({
    protocols: Object.freeze(["openai-responses", "openai-chat-completions"]),
    matches: exactModelIds(["gpt-5.5", "gpt-5.5-2026-04-23"]),
    contextWindow: 1_050_000,
    reasoningMode: "levels",
    reasoningEfforts: OPENAI_GPT_5_5_EFFORTS,
    defaultReasoningEffort: "medium",
    references: Object.freeze(["https://developers.openai.com/api/docs/models/gpt-5.5.md"]),
  }),
  Object.freeze({
    protocols: Object.freeze(["openai-responses", "openai-chat-completions"]),
    matches: exactModelIds(["gpt-5.4", "gpt-5.4-2026-03-05"]),
    contextWindow: 1_050_000,
    reasoningMode: "levels",
    reasoningEfforts: OPENAI_GPT_5_5_EFFORTS,
    defaultReasoningEffort: "none",
    references: Object.freeze(["https://developers.openai.com/api/docs/models/gpt-5.4.md"]),
  }),
  Object.freeze({
    protocols: Object.freeze(["openai-chat-completions"]),
    matches: exactModelIds(QWEN3_7_MAX_IDS),
    contextWindow: 1_000_000,
    reasoningMode: "thinking-toggle",
    reasoningEfforts: QWEN3_7_MAX_CHAT_EFFORTS,
    defaultReasoningEffort: null,
    thinkingToggle: true,
    references: QWEN3_7_MAX_REFERENCES,
  }),
  Object.freeze({
    protocols: Object.freeze(["openai-responses"]),
    matches: exactModelIds(QWEN3_7_MAX_IDS),
    contextWindow: 1_000_000,
    reasoningMode: "levels",
    reasoningEfforts: QWEN3_7_MAX_RESPONSES_EFFORTS,
    defaultReasoningEffort: "medium",
    references: QWEN3_7_MAX_REFERENCES,
  }),
  Object.freeze({
    protocols: Object.freeze(["openai-responses", "openai-chat-completions"]),
    matches: exactModelIds(["deepseek-v4-flash"]),
    contextWindow: 1_000_000,
    reasoningMode: "levels",
    reasoningEfforts: DEEPSEEK_V4_FLASH_EFFORTS,
    defaultReasoningEffort: "high",
    thinkingToggle: true,
    references: Object.freeze([
      "https://api-docs.deepseek.com/api/list-models",
      "https://api-docs.deepseek.com/quick_start/pricing",
      "https://api-docs.deepseek.com/guides/thinking_mode",
      "https://api-docs.deepseek.com/api/create-chat-completion",
    ]),
  }),
  Object.freeze({
    protocols: Object.freeze(["openai-responses", "openai-chat-completions"]),
    matches: exactModelIds(["deepseek-v4-pro"]),
    contextWindow: 1_000_000,
    reasoningMode: "levels",
    reasoningEfforts: DEEPSEEK_V4_PRO_EFFORTS,
    defaultReasoningEffort: "high",
    thinkingToggle: true,
    references: Object.freeze([
      "https://api-docs.deepseek.com/api/list-models",
      "https://api-docs.deepseek.com/quick_start/pricing",
      "https://api-docs.deepseek.com/guides/thinking_mode",
      "https://api-docs.deepseek.com/api/create-chat-completion",
    ]),
  }),
  Object.freeze({
    protocols: Object.freeze(["anthropic-messages"]),
    matches: exactModelIds(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]),
    contextWindow: 1_000_000,
    reasoningMode: "provider-default",
    reasoningEfforts: PROVIDER_DEFAULT_EFFORTS,
    defaultReasoningEffort: null,
    references: Object.freeze([
      "https://platform.claude.com/docs/en/about-claude/models/overview",
      "https://platform.claude.com/docs/en/build-with-claude/effort",
    ]),
  }),
  Object.freeze({
    protocols: Object.freeze(["anthropic-messages"]),
    matches: exactModelIds(["claude-haiku-4-5"]),
    contextWindow: 200_000,
    reasoningMode: "levels",
    reasoningEfforts: NO_REASONING_EFFORTS,
    defaultReasoningEffort: "none",
    references: Object.freeze(["https://platform.claude.com/docs/en/about-claude/models/overview"]),
  }),
  Object.freeze({
    protocols: Object.freeze(["google-gemini"]),
    matches: exactModelIds(["gemini-2.5-pro"]),
    contextWindow: 1_048_576,
    reasoningMode: "provider-default",
    reasoningEfforts: PROVIDER_DEFAULT_EFFORTS,
    defaultReasoningEffort: null,
    references: Object.freeze([
      "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro",
      "https://ai.google.dev/gemini-api/docs/thinking",
    ]),
  }),
  Object.freeze({
    protocols: Object.freeze(["google-gemini"]),
    matches: exactModelIds(["gemini-2.5-flash"]),
    contextWindow: 1_048_576,
    reasoningMode: "provider-default",
    reasoningEfforts: PROVIDER_DEFAULT_EFFORTS,
    defaultReasoningEffort: null,
    references: Object.freeze([
      "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash",
      "https://ai.google.dev/gemini-api/docs/thinking",
    ]),
  }),
  Object.freeze({
    protocols: Object.freeze(["google-gemini"]),
    matches: exactModelIds(["gemini-3-flash-preview"]),
    contextWindow: 1_048_576,
    reasoningMode: "provider-default",
    reasoningEfforts: PROVIDER_DEFAULT_EFFORTS,
    defaultReasoningEffort: null,
    references: Object.freeze([
      "https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview",
      "https://ai.google.dev/gemini-api/docs/thinking",
    ]),
  }),
]);

function normalizeModelId(modelId) {
  return String(modelId ?? "").trim().replace(/^models\//i, "").toLowerCase();
}

export function resolveOfficialModelCapabilities(protocol, modelId) {
  const normalizedModelId = normalizeModelId(modelId);
  if (normalizedModelId === "") return null;
  const entry = OFFICIAL_CAPABILITIES.find((candidate) =>
    candidate.protocols.includes(protocol) && candidate.matches(normalizedModelId),
  );
  if (!entry) return null;
  return {
    contextWindow: entry.contextWindow,
    reasoningMode: entry.reasoningMode,
    reasoningEfforts: [...entry.reasoningEfforts],
    defaultReasoningEffort: entry.defaultReasoningEffort,
    reference: entry.references[0],
    references: [...entry.references],
    ...(entry.thinkingToggle === true ? { thinkingToggle: true } : {}),
  };
}
