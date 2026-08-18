import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [manifest, appInfo, legacyWorkbookHost, httpApp] = await Promise.all([
  readFile(new URL("../manifest.xml", import.meta.url), "utf8"),
  readFile(new URL("../src/shared/app-info.js", import.meta.url), "utf8"),
  readFile(new URL("../launcher/LegacyWorkbookHost.cs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/http-app.js", import.meta.url), "utf8"),
]);

test("Office 清单资源使用服务实际绑定的 IPv4 回环地址", () => {
  const serviceHost = appInfo.match(/SERVICE_HOST\s*=\s*"([^"]+)"/)?.[1];
  const manifestOrigins = [...manifest.matchAll(/https:\/\/([^/:]+):3210/g)].map(
    (match) => match[1],
  );

  assert.equal(serviceHost, "127.0.0.1");
  assert.ok(manifestOrigins.length > 0);
  assert.deepEqual(new Set(manifestOrigins), new Set([serviceHost]));
  assert.doesNotMatch(manifest, /https:\/\/localhost:3210/);
});

test("原生窗格使用同一回环地址并保留旧来源兼容", () => {
  assert.match(legacyWorkbookHost, /https:\/\/127\.0\.0\.1:3210\/taskpane\.html/);
  assert.doesNotMatch(legacyWorkbookHost, /https:\/\/localhost:3210\/taskpane\.html/);
  assert.match(httpApp, /`https:\/\/localhost:\$\{SERVICE_PORT\}`/);
});
