import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const powershellPath = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function runPowerShell(scriptPath, args, options = {}) {
  return spawnSync(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { encoding: "utf8", timeout: 15_000, ...options },
  );
}

function queryRegistryValue(registryPath) {
  const result = spawnSync("reg.exe", ["query", `HKCU\\${registryPath}`, "/v", "ChatExcel Local Service"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return result.stdout.match(/ChatExcel Local Service\s+REG_SZ\s+(.+)\s*$/im)?.[1]?.trim() ?? null;
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ChatExcel startup "));
  const scriptsDirectory = join(root, "scripts");
  const scriptPath = join(scriptsDirectory, "startup-registration.ps1");
  const registryPath = `Software\\ChatExcel\\Tests\\${randomUUID()}`;
  await mkdir(scriptsDirectory, { recursive: true });
  await copyFile(resolve(projectRoot, "scripts", "startup-registration.ps1"), scriptPath);
  await writeFile(join(scriptsDirectory, "start.ps1"), "# fixture\n", "utf8");
  t.after(() => {
    spawnSync("reg.exe", ["delete", `HKCU\\${registryPath}`, "/f"], { encoding: "utf8" });
    return rm(root, { recursive: true, force: true });
  });
  return { root, scriptPath, registryPath };
}

test("启动项脚本使用固定当前用户值并保持路径参数边界", async () => {
  const scriptBytes = await readFile(resolve(projectRoot, "scripts", "startup-registration.ps1"));
  const script = scriptBytes.toString("utf8");

  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(script, /Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(script, /ChatExcel Local Service/);
  assert.match(script, /Registry\]::CurrentUser/);
  assert.match(script, /RegistryValueKind\]::String/);
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.doesNotMatch(script, /HKLM|Register-ScheduledTask|schtasks|New-Service|Invoke-Expression/i);
});

test("Launcher 仅在 Office 旁加载成功后登记 service-only 启动项", async () => {
  const launcher = await readFile(resolve(projectRoot, "launcher", "Program.cs"), "utf8");

  assert.match(launcher, /scripts\/startup-registration\.ps1/);
  assert.match(launcher, /RunSideload\([\s\S]*?InstallLoginStartup\(/);
  assert.match(launcher, /"-Action",\s*"Install",\s*"-LauncherPath"/);
  assert.match(launcher, /--service-only/);
  assert.doesNotMatch(
    launcher.match(/if \(launchRequest\.Mode == WorkbookLaunchMode\.ServiceOnly\)[\s\S]*?return 0;/)?.[0] ?? "",
    /InstallLoginStartup/,
  );
});

test("Windows 源码启动项支持空格路径并只删除自身值", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createFixture(t);
  const commonArgs = ["-RegistrySubKey", fixture.registryPath];

  const install = runPowerShell(fixture.scriptPath, ["-Action", "Install", ...commonArgs], { cwd: fixture.root });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const installedCommand = queryRegistryValue(fixture.registryPath);
  assert.match(installedCommand ?? "", /^"[^"]+powershell\.exe"/i);
  assert.match(installedCommand ?? "", /-WindowStyle Hidden/);
  assert.match(installedCommand ?? "", /-File "[^"]+ChatExcel startup [^"]+\\scripts\\start\.ps1"$/i);

  const status = runPowerShell(fixture.scriptPath, ["-Action", "Status", ...commonArgs], { cwd: fixture.root });
  assert.equal(status.status, 0, status.stderr || status.stdout);

  const foreignCommand = '"C:\\Other ChatExcel\\ChatExcel Launcher.exe" --service-only';
  const replace = spawnSync(
    "reg.exe",
    ["add", `HKCU\\${fixture.registryPath}`, "/v", "ChatExcel Local Service", "/t", "REG_SZ", "/d", foreignCommand, "/f"],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(replace.status, 0, replace.stderr || replace.stdout);

  const protectedUninstall = runPowerShell(fixture.scriptPath, ["-Action", "Uninstall", ...commonArgs], { cwd: fixture.root });
  assert.equal(protectedUninstall.status, 0, protectedUninstall.stderr || protectedUninstall.stdout);
  assert.equal(queryRegistryValue(fixture.registryPath), foreignCommand);

  assert.equal(runPowerShell(fixture.scriptPath, ["-Action", "Install", ...commonArgs], { cwd: fixture.root }).status, 0);
  assert.equal(runPowerShell(fixture.scriptPath, ["-Action", "Uninstall", ...commonArgs], { cwd: fixture.root }).status, 0);
  assert.equal(queryRegistryValue(fixture.registryPath), null);
});

test("Windows 发行启动项完整引用 Launcher 并附加 service-only", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createFixture(t);
  const launcherPath = join(fixture.root, "ChatExcel Launcher.exe");
  await writeFile(launcherPath, "fixture", "utf8");

  const result = runPowerShell(
    fixture.scriptPath,
    ["-Action", "Install", "-LauncherPath", launcherPath, "-RegistrySubKey", fixture.registryPath],
    { cwd: fixture.root },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(queryRegistryValue(fixture.registryPath), `"${launcherPath}" --service-only`);
});
