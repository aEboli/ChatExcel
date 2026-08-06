import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProtocolEndpoints,
  normalizeApiRoot,
  protocolAuthHeaders,
  protocolCompatibleReasoningEfforts,
  protocolReasoningEfforts,
} from "../src/server/protocols.js";

test("协议根地址去除版本和方法后缀并保留网关路径", () => {
  assert.equal(normalizeApiRoot("https://gateway.example/openai/v1/responses"), "https://gateway.example/openai");
  assert.equal(buildProtocolEndpoints("openai-chat-completions", "https://gateway.example/openai").endpoint, "https://gateway.example/openai/v1/chat/completions");
  assert.equal(buildProtocolEndpoints("anthropic-messages", "https://api.anthropic.com/v1").modelsUrl, "https://api.anthropic.com/v1/models");
  assert.equal(buildProtocolEndpoints("google-gemini", "https://generativelanguage.googleapis.com/v1beta", "models/gemini-2.5-flash").endpoint, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
});

test("协议认证头和思考等级映射按提供方区分", () => {
  assert.deepEqual(protocolAuthHeaders("openai-responses", "secret"), { Authorization: "Bearer secret" });
  assert.deepEqual(protocolAuthHeaders("anthropic-messages", "secret"), {
    "x-api-key": "secret",
    "anthropic-version": "2023-06-01",
  });
  assert.deepEqual(protocolAuthHeaders("google-gemini", "secret"), { "x-goog-api-key": "secret" });
  assert.deepEqual(protocolReasoningEfforts("google-gemini", "gemini-2.5-flash"), ["none", "low", "medium", "high"]);
  assert.deepEqual(protocolReasoningEfforts("anthropic-messages", "claude-sonnet"), ["none", "low", "medium", "high"]);
});

test("仅缺失等级的 OpenAI 模型使用受限兼容集合", () => {
  assert.deepEqual(protocolReasoningEfforts("openai-responses", "gateway-unknown"), []);
  assert.deepEqual(protocolReasoningEfforts("openai-chat-completions", "gpt-5-unverified"), []);
  assert.deepEqual(protocolCompatibleReasoningEfforts("openai-responses"), ["low", "medium", "high"]);
  assert.deepEqual(protocolCompatibleReasoningEfforts("openai-chat-completions"), ["low", "medium", "high"]);
  assert.deepEqual(protocolCompatibleReasoningEfforts("anthropic-messages"), []);
});
