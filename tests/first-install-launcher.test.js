import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function writeFixtureFile(root, relativePath, contents) {
  const filePath = join(root, relativePath);
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function createInstallFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chatexcel-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scriptPath = join(root, "scripts", "first-install.ps1");
  const fakeBin = join(root, "fake-bin");
  const logPath = join(root, "commands.log");
  const certificateState = join(root, "certificate-ready");
  const npmStub = join(root, "npm-stub.mjs");

  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(resolve(projectRoot, "scripts", "first-install.ps1"), scriptPath);
  await writeFixtureFile(root, "package.json", "{}\n");
  await writeFixtureFile(root, "package-lock.json", "{\"name\":\"fixture\"}\n");
  await writeFixtureFile(root, "manifest.xml", "<OfficeApp />\n");
  await writeFixtureFile(root, "scripts/start.ps1", "# fixture\n");
  await writeFixtureFile(root, "scripts/stop.ps1", "# fixture\n");
  await writeFixtureFile(root, "scripts/service-supervisor.ps1", "# fixture\n");
  await writeFixtureFile(root, "scripts/sideload.mjs", "// fixture\n");
  await writeFixtureFile(root, "src/server/index.js", "// fixture\n");
  await writeFixtureFile(root, "src/taskpane/taskpane.html", "<!-- fixture -->\n");
  await writeFile(join(root, "scripts", "verify-certs.mjs"), `
import { existsSync } from "node:fs";
process.exit(existsSync(process.env.CHATEXCEL_TEST_CERTIFICATE_STATE) ? 0 : 17);
`, "utf8");
  await writeFile(npmStub, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.CHATEXCEL_TEST_LOG, JSON.stringify(args) + "\\n");
function write(relativePath) {
  const path = join(process.cwd(), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\\n");
}
if (args[0] === "ci") {
  for (const file of [
    "node_modules/.package-lock.json",
    "node_modules/express/package.json",
    "node_modules/smol-toml/package.json",
    "node_modules/office-addin-dev-certs/package.json",
    "node_modules/office-addin-dev-certs/cli.js",
    "node_modules/office-addin-dev-settings/package.json",
    "node_modules/office-addin-manifest/package.json",
    "node_modules/.bin/office-addin-dev-certs.cmd",
    "node_modules/.bin/office-addin-manifest.cmd",
  ]) write(file);
  process.exit(0);
}
if (args[0] === "ls") process.exit(0);
if (args[0] === "run" && args[1] === "certs:install") {
  writeFileSync(process.env.CHATEXCEL_TEST_CERTIFICATE_STATE, "ready");
  process.exit(0);
}
if (args[0] === "run" && ["validate:manifest", "sideload"].includes(args[1])) process.exit(0);
process.exit(90);
`, "utf8");
  await writeFile(join(fakeBin, "npm.cmd"), "@echo off\r\n\"%CHATEXCEL_TEST_NODE%\" \"%CHATEXCEL_TEST_NPM_STUB%\" %*\r\nexit /b %ERRORLEVEL%\r\n", "ascii");
  await writeFile(logPath, "", "utf8");

  return {
    root,
    scriptPath,
    logPath,
    environment: {
      ...process.env,
      PATH: `${fakeBin};${process.env.PATH ?? ""}`,
      CHATEXCEL_TEST_NODE: process.execPath,
      CHATEXCEL_TEST_NPM_STUB: npmStub,
      CHATEXCEL_TEST_LOG: logPath,
      CHATEXCEL_TEST_CERTIFICATE_STATE: certificateState,
    },
  };
}

test("根目录初次安装入口只调用固定 PowerShell 脚本并在失败时保留窗口", async () => {
  const launcherBytes = await readFile(resolve(projectRoot, "首次安装并启动 ChatExcel.cmd"));
  const launcher = launcherBytes.toString("utf8");

  assert.match(launcher, /%~dp0scripts\\first-install\.ps1/);
  assert.match(launcher, /WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File[\s\S]*?-Action Menu/);
  assert.match(launcher, /if not "%CHATEXCEL_FIRST_INSTALL_EXIT_CODE%"=="0"[\s\S]*?pause/);
  assert.doesNotMatch(launcher, /%\*|%[1-9]/);
  assert.equal([...launcherBytes].some((byte) => byte > 0x7f), false);
});

test("初次安装脚本使用 PowerShell 5.1 可用的依赖校验并复用现有旁加载流程", async () => {
  const scriptBytes = await readFile(resolve(projectRoot, "scripts", "first-install.ps1"));
  const script = scriptBytes.toString("utf8");

  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(script, /function Get-FileSha256[\s\S]*?SHA256\]::Create\(\)/);
  assert.doesNotMatch(script, /Get-FileHash/);
  assert.match(script, /Get-Command node\.exe/);
  assert.match(script, /Get-Command npm\.cmd/);
  assert.match(script, /ValidateSet\("Menu", "Install", "Uninstall"\)/);
  assert.match(script, /"1"\s*\{[\s\S]*?Invoke-Install/);
  assert.match(script, /"2"\s*\{[\s\S]*?Invoke-Uninstall/);
  assert.match(script, /"3"\s*\{[\s\S]*?return/);
  assert.match(script, /IsNullOrWhiteSpace\(\$selection\)[\s\S]*?return/);
  assert.match(script, /@\("ci", "--no-audit", "--no-fund"\)/);
  assert.match(script, /npmPath ls --all --include=dev --silent/);
  assert.match(script, /@\("run", "certs:install"\)/);
  assert.match(script, /@\("run", "validate:manifest"\)/);
  assert.match(script, /@\("run", "sideload"\)/);
  assert.match(script, /@\("run", "unregister"\)/);
  assert.match(script, /Remove-ProjectDirectory \$nodeModulesDirectory "node_modules"/);
  assert.match(script, /Get-Process -Name EXCEL/);
  assert.match(script, /function Remove-ProjectDirectory/);
  assert.doesNotMatch(script, /Invoke-Expression/);
});

test("证书验证保持 Node 20 兼容", async () => {
  const verifier = await readFile(resolve(projectRoot, "scripts", "verify-certs.mjs"), "utf8");

  assert.match(verifier, /officeAddinDevCerts\.verifyCertificates\(\)/);
  assert.doesNotMatch(verifier, /getCACertificates/);
});

test("Windows 菜单选择 3 后退出", { skip: process.platform !== "win32" }, () => {
  const command = "(echo 3)|powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts\\first-install.ps1 -Action Menu";
  const result = spawnSync("cmd.exe", ["/d", "/c", command], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /1\. 安装\/重装该项目/);
});

test("Windows 卸载仅删除项目依赖并保留源码目录", { skip: process.platform !== "win32" }, async (t) => {
  const excelCheck = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "[bool](Get-Process -Name EXCEL -ErrorAction SilentlyContinue | Select-Object -First 1)"],
    { encoding: "utf8" },
  );
  if (excelCheck.status === 0 && excelCheck.stdout.trim() === "True") {
    t.skip("Excel 正在运行，卸载保护阻止删除测试夹具。");
    return;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "chatexcel-uninstall-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const scriptDirectory = join(fixtureRoot, "scripts");
  const fixtureScript = join(scriptDirectory, "first-install.ps1");
  const dependencyDirectory = join(fixtureRoot, "node_modules");
  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(dependencyDirectory, { recursive: true });
  await copyFile(resolve(projectRoot, "scripts", "first-install.ps1"), fixtureScript);
  await writeFile(join(dependencyDirectory, "sentinel.txt"), "dependency", "utf8");
  await writeFile(join(fixtureRoot, "README.keep"), "source", "utf8");

  const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixtureScript, "-Action", "Uninstall"],
    { cwd: fixtureRoot, encoding: "utf8", timeout: 15_000 },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(() => readFile(join(dependencyDirectory, "sentinel.txt"), "utf8"));
  assert.equal(await readFile(join(fixtureRoot, "README.keep"), "utf8"), "source");
});

test("Windows 安装动作按锁文件重装依赖、准备证书并旁加载", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createInstallFixture(t);
  const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture.scriptPath, "-Action", "Install"],
    { cwd: fixture.root, env: fixture.environment, encoding: "utf8", timeout: 20_000 },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const commands = (await readFile(fixture.logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(commands, [
    ["ci", "--no-audit", "--no-fund"],
    ["ls", "--all", "--include=dev", "--silent"],
    ["run", "certs:install"],
    ["run", "validate:manifest"],
    ["run", "sideload"],
  ]);
});
