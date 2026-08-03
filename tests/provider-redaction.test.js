import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeProviderErrorSummary } from "../src/server/provider-redaction.js";

test("认证错误摘要不会保留 Basic、Bearer、JSON 或查询认证载荷", () => {
  const secrets = ["known-secret", "json-secret", "basic-secret", "bearer-secret", "query-secret"];
  const summary = sanitizeProviderErrorSummary([
    '{"token":"json-secret","authorization":"Basic basic-secret"}',
    "Authorization: Bearer bearer-secret",
    "https://provider.example/error?access_token=query-secret",
    "Bearer known-secret",
  ].join(" "), { secrets: ["known-secret"] });

  for (const secret of secrets) assert.equal(summary.includes(secret), false);
  assert.match(summary, /"token":\[REDACTED\]/);
  assert.match(summary, /Authorization:\s*\[REDACTED\]/);
  assert.match(summary, /access_token=\[REDACTED\]/);
});

test("Authorization Basic 和 Bearer 载荷不会被通用字段规则截断后残留", () => {
  const summary = sanitizeProviderErrorSummary([
    "Authorization: Basic dGVzdDpzZWNyZXQ=",
    "Authorization: Bearer bearer-value",
  ].join("; "));

  assert.equal(summary.includes("dGVzdDpzZWNyZXQ="), false);
  assert.equal(summary.includes("bearer-value"), false);
  assert.equal((summary.match(/Authorization: \[REDACTED\]/g) ?? []).length, 2);
});
