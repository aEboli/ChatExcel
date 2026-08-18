import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadClaudeConfig,
  loadSystemConfig,
  parseClaudeConfig,
  resolveClaudeConfigPath,
} from "../src/server/system-config.js";

const claudeSettings = JSON.stringify({
  model: "opus[1m]",
  env: {
    ANTHROPIC_BASE_URL: "http://localhost:8080",
    ANTHROPIC_AUTH_TOKEN: "claude-secret",
    CLAUDE_CODE_EFFORT_LEVEL: "max",
  },
});

test("解析 Claude CLI settings.json 的 Anthropic 配置", () => {
  const config = parseClaudeConfig(claudeSettings, { configPath: "settings.json" });

  assert.equal(config.cliSource, "claude");
  assert.equal(config.protocol, "anthropic-messages");
  assert.equal(config.model, "opus[1m]");
  assert.equal(config.endpoint, "http://localhost:8080/v1/messages");
  assert.equal(config.token, "claude-secret");
  assert.equal(config.tokenSource, "claude-settings");
});

test("自动来源在 Codex 不可用时回退 Claude CLI", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "chatexcel-system-config-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await writeFile(join(homeDir, ".claude", "settings.json"), claudeSettings, "utf8");

  const config = await loadSystemConfig({ homeDir });

  assert.equal(config.cliSource, "claude");
  assert.equal(config.token, "claude-secret");
  assert.equal(resolveClaudeConfigPath({ homeDir }), join(homeDir, ".claude", "settings.json"));
  assert.equal((await loadClaudeConfig({ homeDir })).providerName, "Claude CLI");
});

test("显式 Claude 来源缺少令牌时失败关闭", () => {
  assert.throws(
    () => parseClaudeConfig(JSON.stringify({ model: "claude-sonnet", env: { ANTHROPIC_BASE_URL: "https://example.test" } })),
    (error) => error.code === "CLAUDE_TOKEN_MISSING",
  );
});
