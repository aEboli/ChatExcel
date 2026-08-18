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
  assert.match(startScript, /listener\.OwningProcess -eq \$tracked\.Id/);
  assert.match(startScript, /\$serviceAddress = "127\.0\.0\.1"/);
  assert.match(startScript, /response\.service -ne \$expectedService/);
  assert.match(startScript, /response\.version -ne \$expectedVersion/);
  assert.match(startScript, /requiredCapabilities = @\("office-addin", "native-xls"\)/);
  assert.match(startScript, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(startScript, /actualStartTicks -ne \$startTicks/);
  assert.match(startScript, /commandLine\.IndexOf\(\$recordedEntryPath/);
  assert.match(startScript, /service\.identity/);
  assert.match(startScript, /Set-Content -LiteralPath \$identityPath -Value \$identity -Encoding utf8/);
  assert.match(startScript, /pidMatchesStart[\s\S]*?TotalSeconds\) -le 5/);
  assert.match(startScript, /src\[\\\\\/\]server\[\\\\\/\]index\\\.js/);
});

test("守护器只恢复受管服务且保留外部端口所有权", async () => {
  const supervisorScript = await readProjectFile("scripts", "service-supervisor.ps1");

  assert.match(supervisorScript, /Get-TrackedService/);
  assert.match(supervisorScript, /OwningProcess -eq \$tracked\.Id/);
  assert.match(supervisorScript, /not adopted or stopped/);
  assert.match(supervisorScript, /service\.stop/);
  assert.match(supervisorScript, /\$healthFailureThreshold = 3/);
  assert.match(supervisorScript, /\$maximumRecoveryDelaySeconds = 30/);
  assert.match(supervisorScript, /Schedule-Recovery/);
  assert.match(supervisorScript, /Test-RecoveryDue/);
  assert.match(supervisorScript, /Where-Object \{ \$_.LocalAddress -eq \$serviceAddress \}/);
  assert.match(supervisorScript, /ArgumentList @\(\(Quote-ProcessArgument \$serviceEntryPath\)\)/);
  assert.match(supervisorScript, /\$process\.StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(supervisorScript, /\$startedNodePath,\s*\$serviceEntryPath/);
  assert.match(supervisorScript, /Set-Content -LiteralPath \$identityPath -Value \$serviceIdentity -Encoding utf8/);
  assert.match(supervisorScript, /Set-Content -LiteralPath \$pidPath -Value \$process\.Id -Encoding ascii/);
  assert.match(supervisorScript, /Stop-Process -Id \$process\.Id -Force/);
  assert.match(supervisorScript, /Stop-Process -Id \$process\.Id -Force[\s\S]*?Remove-ServicePid/);
  assert.equal([...supervisorScript].some((character) => character.charCodeAt(0) > 0x7f), false);
});

test("受控恢复冒烟脚本隔离外部监听并验证停止后的状态", async () => {
  const smokeScript = await readProjectFile("scripts", "test-service-recovery.ps1");
  const packageJson = JSON.parse(await readProjectFile("package.json"));

  assert.match(smokeScript, /ExternalListenerPreserved/);
  assert.match(smokeScript, /RecoveredManagedPid/);
  assert.match(smokeScript, /ExplicitStopPreventedRestart/);
  assert.match(smokeScript, /\$serviceAddress = "127\.0\.0\.1"/);
  assert.match(smokeScript, /\$healthUrl = "https:\/\/\$\{serviceAddress\}:\$servicePort\/api\/health"/);
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
  assert.match(stopScript, /\$_.LocalAddress -eq \$serviceAddress -and \$_.OwningProcess -eq \$servicePid/);
  assert.match(stopScript, /actualStartTicks -ne \$startTicks/);
  assert.match(stopScript, /recordedEntryPath -ine \$serviceEntryPath/);
  assert.match(stopScript, /Remove-Item -LiteralPath \$pidPath,\$identityPath/);
  assert.match(stopScript, /actualNodePath -ine \$nodePath/);
  assert.match(stopScript, /pidMatchesStart[\s\S]*?TotalSeconds\) -le 5/);
});

test("发行构建传播原生命令失败并注入 package.json 版本", async () => {
  const buildScript = await readProjectFile("scripts", "build-launcher.ps1");

  assert.match(buildScript, /dotnet publish[\s\S]*?"-p:Version=\$releaseVersion"/);
  assert.match(buildScript, /"-p:AssemblyVersion=\$releaseVersion\.0"/);
  assert.match(buildScript, /dotnet publish failed with exit code \$LASTEXITCODE/);
  assert.match(buildScript, /npm install[\s\S]*?npm install failed with exit code \$LASTEXITCODE/);
  assert.match(buildScript, /version = \$releaseVersion/);
  assert.match(buildScript, /FileVersion does not match package\.json version/);
  assert.match(buildScript, /release\.json version does not match package\.json version/);
  assert.match(buildScript, /runtime package\.json version does not match package\.json version/);
});

test("启动器将服务守护脚本视为发行必需资源", async () => {
  const launcher = await readProjectFile("launcher", "Program.cs");

  assert.match(launcher, /"scripts\/service-supervisor\.ps1",/);
});
