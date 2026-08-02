import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/server/settings-store.js";

test("设置文件保存最大步骤数和审批偏好且不写入明文 API Key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatexcel-settings-"));
  const settingsPath = join(directory, "settings.json");
  const store = new SettingsStore({
    settingsPath,
    protectSecret: async () => "ciphertext-value",
    unprotectSecret: async () => "secret-api-key",
  });

  await store.save({
    useSystemConfig: false,
    maxSteps: 100,
    approvalMode: "auto",
    custom: {
      protocol: "openai-responses",
      apiUrl: "https://api.example.com",
      apiKey: "secret-api-key",
      model: "gpt-test",
      contextWindow: 128000,
      catalog: [],
    },
  });
  const source = await readFile(settingsPath, "utf8");
  assert.equal(source.includes("secret-api-key"), false);
  const persisted = JSON.parse(source);
  assert.equal(persisted.maxSteps, 100);
  assert.equal(persisted.approvalMode, "auto");
  assert.equal(await store.decryptCustom(persisted.custom), "secret-api-key");
});

test("设置文件拒绝未知审批模式", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatexcel-settings-"));
  const store = new SettingsStore({
    settingsPath: join(directory, "settings.json"),
    protectSecret: async () => "ciphertext-value",
    unprotectSecret: async () => "secret-api-key",
  });

  await assert.rejects(
    () => store.save({ useSystemConfig: true, custom: null, approvalMode: "ask" }),
    (error) => error?.code === "APPROVAL_MODE_INVALID",
  );
});
