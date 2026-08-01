import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/server/settings-store.js";

test("设置文件保存最大步骤数且不写入明文 API Key", async () => {
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
  assert.equal(JSON.parse(source).maxSteps, 100);
  assert.equal(await store.decryptCustom(JSON.parse(source).custom), "secret-api-key");
});
