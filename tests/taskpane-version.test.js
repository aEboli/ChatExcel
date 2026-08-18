import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [packageJson, packageLock, taskpaneHtml, taskpaneCss, taskpaneJs, appInfo, httpApp] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/taskpane/taskpane.html", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.css", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.js", import.meta.url), "utf8"),
  readFile(new URL("../src/shared/app-info.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/http-app.js", import.meta.url), "utf8"),
]);

test("发行版本从根包同步到锁文件和健康接口", () => {
  assert.equal(packageJson.version, "0.0.4");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.match(appInfo, /APP_VERSION = packageManifest\.version/);
  assert.match(httpApp, /version:\s*APP_VERSION/);
});

test("版本槽仅位于设置页顶部", () => {
  const topbar = taskpaneHtml.match(/<header class="topbar[\s\S]*?<\/header>/)?.[0] ?? "";
  const settingsHeader = taskpaneHtml.match(/<header class="settings-header[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.doesNotMatch(topbar, /id="app-version"/);
  assert.match(settingsHeader, /id="app-version"[^>]+data-version-state="loading"[^>]*>v--<\/span>/);
  assert.match(taskpaneCss, /\.topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 38px;/);
  assert.match(taskpaneCss, /\.settings-header\s*\{[\s\S]*?grid-template-columns:\s*38px minmax\(0, 1fr\);/);
  assert.match(taskpaneCss, /\.settings-heading\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(taskpaneCss, /\.app-version\s*\{[\s\S]*?min-width:\s*42px;/);
});

test("任务窗格从健康接口显示版本并对失败关闭", () => {
  assert.match(taskpaneJs, /appVersion:\s*document\.querySelector\("#app-version"\)/);
  assert.match(taskpaneJs, /async function loadAppVersion\(\)[\s\S]*?requestJson\("\/api\/health"\)/);
  assert.match(taskpaneJs, /elements\.appVersion\.textContent = available \? `v\$\{normalizedVersion\}` : "v--"/);
  assert.match(taskpaneJs, /catch\s*\{\s*setAppVersion\(null\);\s*\}/);
  assert.match(taskpaneJs, /void loadAppVersion\(\);/);
});
