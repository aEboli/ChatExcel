const AUTH_FIELD_PATTERN = /((?:["']?(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|id[-_]?token|token|secret|credential)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;}&]+|[^\s,;}&]+)/gi;
const AUTH_QUERY_PATTERN = /([?&](?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|id[-_]?token|token|secret|credential)=)[^&#\s]*/gi;
const BEARER_PATTERN = /\bbearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi;
const BASIC_PATTERN = /\bbasic\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi;

function redactKnownSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret === "") continue;
    result = result.split(secret).join("[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) result = result.split(encoded).join("[REDACTED]");
  }
  return result;
}

export function sanitizeProviderErrorSummary(text, { secrets = [], maxLength = 500 } = {}) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 500;
  const summary = redactKnownSecrets(typeof text === "string" ? text : "", secrets);
  return summary
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(BASIC_PATTERN, "Basic [REDACTED]")
    .replace(AUTH_FIELD_PATTERN, "$1[REDACTED]")
    .replace(AUTH_QUERY_PATTERN, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
