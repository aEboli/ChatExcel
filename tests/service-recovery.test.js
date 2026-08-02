import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readProjectFile(...segments) {
  return readFile(resolve(projectRoot, ...segments), "utf8");
}

test("启动脚本将服务生命周期交给项目范围的守护器", async () => {
  const startScript = await readProjectFile("scripts", "start.ps1");

  assert.match(startScript, /service-supervisor\.ps1/);
  assert.match(startScript, /service-supervisor\.pid/);
  assert.match(startScript, /Start-Supervisor/);
  assert.match(startScript, /Wait-ForHealth/);
  assert.match(startScript, /Port \$servicePort is already owned/);
  assert.doesNotMatch(startScript, /native-xls/);
  assert.match(startScript, /listener\.OwningProcess -eq \$tracked\.Id/);
});

test("守护器只恢复受管服务且保留外部端口所有权", async () => {
  const supervisorScript = await readProjectFile("scripts", "service-supervisor.ps1");

  assert.match(supervisorScript, /Get-TrackedService/);
  assert.match(supervisorScript, /OwningProcess -eq \$tracked\.Id/);
  assert.match(supervisorScript, /not adopted or stopped/);
  assert.match(supervisorScript, /service\.stop/);
  assert.doesNotMatch(supervisorScript, /native-xls/);
  assert.match(supervisorScript, /\$healthFailureThreshold = 3/);
  assert.match(supervisorScript, /\$maximumRecoveryDelaySeconds = 30/);
  assert.match(supervisorScript, /Schedule-Recovery/);
  assert.match(supervisorScript, /Test-RecoveryDue/);
  assert.equal([...supervisorScript].some((character) => character.charCodeAt(0) > 0x7f), false);
});

test("受控恢复冒烟脚本隔离外部监听并验证停止后的状态", async () => {
  const smokeScript = await readProjectFile("scripts", "test-service-recovery.ps1");
  const packageJson = JSON.parse(await readProjectFile("package.json"));

  assert.match(smokeScript, /ExternalListenerPreserved/);
  assert.match(smokeScript, /RecoveredManagedPid/);
  assert.match(smokeScript, /ExplicitStopPreventedRestart/);
  assert.match(smokeScript, /Start-Process/);
  assert.equal(
    packageJson.scripts["test:service-recovery"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-service-recovery.ps1",
  );
});

test("显式停止会先禁止恢复守护器", async () => {
  const stopScript = await readProjectFile("scripts", "stop.ps1");

  assert.match(stopScript, /New-Item -ItemType File -Force -Path \$stopPath/);
  assert.match(stopScript, /Stop-ManagedSupervisor/);
  assert.match(stopScript, /Test-SupervisorLockHeld/);
  assert.match(stopScript, /Remove-Item -LiteralPath \$supervisorPidPath,\$supervisorLockPath,\$stopPath/);
});

test("启动器将服务守护脚本视为发行必需资源", async () => {
  const launcher = await readProjectFile("launcher", "Program.cs");

  assert.match(launcher, /"scripts\/service-supervisor\.ps1",/);
});
