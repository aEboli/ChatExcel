export const DEFAULT_PROTOCOL = "openai-responses";

export const PROTOCOL_DEFINITIONS = Object.freeze({
  "openai-responses": Object.freeze({
    id: "openai-responses",
    label: "OpenAI Responses",
    family: "openai",
    version: "v1",
  }),
  "openai-chat-completions": Object.freeze({
    id: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    family: "openai",
    version: "v1",
  }),
  "anthropic-messages": Object.freeze({
    id: "anthropic-messages",
    label: "Anthropic Messages",
    family: "anthropic",
    version: "v1",
  }),
  "google-gemini": Object.freeze({
    id: "google-gemini",
    label: "Google Gemini generateContent",
    family: "gemini",
    version: "v1beta",
  }),
});

const KNOWN_SUFFIXES = [
  /\/v1beta\/models\/[^/]+:generatecontent$/i,
  /\/v1\/chat\/completions$/i,
  /\/v1\/responses$/i,
  /\/v1\/messages$/i,
  /\/v1beta\/models$/i,
  /\/v1beta$/i,
  /\/v1\/models$/i,
  /\/v1$/i,
];

function requireProtocol(protocol) {
  const value = protocol === "responses" ? DEFAULT_PROTOCOL : protocol;
  const definition = PROTOCOL_DEFINITIONS[value];
  if (!definition) {
    throw new TypeError(`不支持的协议：${protocol ?? "(missing)"}`);
  }
  return definition;
}

export function getProtocolDefinition(protocol) {
  return requireProtocol(protocol);
}

export function protocolOptions() {
  return Object.values(PROTOCOL_DEFINITIONS).map(({ id, label }) => ({ id, label }));
}

export function normalizeApiRoot(rawBaseUrl) {
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch (error) {
    throw new TypeError("API URL 不是有效 URL。", { cause: error });
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new TypeError("API URL 仅支持 HTTP 或 HTTPS。" );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("API URL 不能包含凭据、查询参数或片段。" );
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  for (const suffix of KNOWN_SUFFIXES) {
    if (suffix.test(path)) {
      path = path.replace(suffix, "");
      break;
    }
  }
  path = path.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export function buildProtocolEndpoints(protocol, rawBaseUrl, model = "") {
  const definition = requireProtocol(protocol);
  const baseUrl = normalizeApiRoot(rawBaseUrl);
  const versionRoot = `${baseUrl}/${definition.version}`;
  if (definition.id === "openai-responses") {
    return {
      protocol: definition.id,
      baseUrl,
      endpoint: `${versionRoot}/responses`,
      modelsUrl: `${versionRoot}/models`,
    };
  }
  if (definition.id === "openai-chat-completions") {
    return {
      protocol: definition.id,
      baseUrl,
      endpoint: `${versionRoot}/chat/completions`,
      modelsUrl: `${versionRoot}/models`,
    };
  }
  if (definition.id === "anthropic-messages") {
    return {
      protocol: definition.id,
      baseUrl,
      endpoint: `${versionRoot}/messages`,
      modelsUrl: `${versionRoot}/models`,
    };
  }
  const modelId = String(model).replace(/^models\//i, "");
  return {
    protocol: definition.id,
    baseUrl,
    endpoint: modelId === ""
      ? null
      : `${versionRoot}/models/${encodeURIComponent(modelId)}:generateContent`,
    modelsUrl: `${versionRoot}/models`,
  };
}

export function protocolAuthHeaders(protocol, token) {
  const definition = requireProtocol(protocol);
  if (definition.family === "anthropic") {
    return {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    };
  }
  if (definition.family === "gemini") {
    return { "x-goog-api-key": token };
  }
  return { Authorization: `Bearer ${token}` };
}

export function protocolReasoningEfforts(protocol, modelId) {
  const definition = requireProtocol(protocol);
  const normalized = String(modelId).toLowerCase();
  if (definition.family === "gemini") {
    if (/gemini-3|thinking/.test(normalized)) {
      return ["none", "minimal", "low", "medium", "high"];
    }
    if (/gemini-2\.5/.test(normalized)) {
      return ["none", "low", "medium", "high"];
    }
    return ["none"];
  }
  if (definition.family === "anthropic") {
    return /claude|thinking|reason/.test(normalized)
      ? ["none", "low", "medium", "high"]
      : ["none"];
  }
  if (/^(gpt-5|gpt-6|o[134](?:\b|[-_.])|codex)|reason|thinking/.test(normalized)) {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  return ["none"];
}

export function clampReasoningEffort(protocol, effort) {
  if (!effort || effort === "none") return null;
  const definition = requireProtocol(protocol);
  if (definition.family === "gemini") {
    if (effort === "minimal") return "minimal";
    if (["low", "medium", "high"].includes(effort)) return effort;
    return "high";
  }
  if (definition.family === "anthropic") {
    if (["low", "medium", "high"].includes(effort)) return effort;
    return "high";
  }
  return effort;
}

export function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new TypeError("图片 data URL 无效。" );
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}
