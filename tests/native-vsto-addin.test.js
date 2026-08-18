import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readProjectFile(...segments) {
  return readFile(resolve(projectRoot, ...segments), "utf8");
}

test("VSTO 探针保留 x64 net48、自定义窗格和 Ribbon 受支持入口", async () => {
  const [project, addIn, ribbon, pane] = await Promise.all([
    readProjectFile("native-addin", "vsto", "ChatExcel.NativeVstoAddIn.csproj"),
    readProjectFile("native-addin", "vsto", "ThisAddIn.cs"),
    readProjectFile("native-addin", "vsto", "NativeRibbon.cs"),
    readProjectFile("native-addin", "vsto", "NativeTaskPaneControl.cs"),
  ]);

  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/);
  assert.match(project, /Microsoft\.VisualStudio\.Tools\.Office\.targets/);
  assert.match(project, /<SignManifests>true<\/SignManifests>/);
  assert.match(project, /ManifestCertificateThumbprint/);
  assert.match(addIn, /CustomTaskPanes\.Add\(taskPaneControl, TaskPaneTitle\)/);
  assert.match(addIn, /msoCTPDockPositionRight/);
  assert.match(addIn, /CreateRibbonExtensibilityObject\(\)/);
  assert.doesNotMatch(addIn, /RequestService/);
  assert.match(ribbon, /\[ComVisible\(true\)\]/);
  assert.match(ribbon, /public sealed class NativeRibbon/);
  assert.match(ribbon, /Office\.IRibbonExtensibility/);
  assert.doesNotMatch(pane, /localhost|TcpListener|HttpListener|WebView2/i);
});

test("VSTO 安装脚本只走当前用户受控部署，不使用裸 COM 或机器范围注册", async () => {
  const script = await readProjectFile("scripts", "native-vsto-addin.ps1");

  assert.match(script, /VSTOInstaller\.exe/);
  assert.match(script, /\/Install \$manifestPath \/Silent/);
  assert.match(script, /\/Uninstall \$installedUri \/Silent/);
  assert.match(script, /HKCU:\\Software\\Microsoft\\Office\\Excel\\Addins/);
  assert.match(script, /HKCU:\\Software\\Microsoft\\VSTO\\Security\\Inclusion/);
  assert.match(script, /WindowsBuiltInRole\]::Administrator/);
  assert.match(script, /\.IsSystem/);
  assert.match(script, /%?LOCALAPPDATA|\$env:LOCALAPPDATA/);
  assert.match(script, /Assert-ExcelStopped/);
  assert.doesNotMatch(script, /HKCR:|HKLM:.*ChatExcel|RegAsm|Register-ScheduledTask|schtasks|New-Service|SYSTEM -Force/i);
});

test("VSTO 探针脚本不启动或依赖本地网络服务", async () => {
  const [script, project, pane] = await Promise.all([
    readProjectFile("scripts", "native-vsto-addin.ps1"),
    readProjectFile("native-addin", "vsto", "ChatExcel.NativeVstoAddIn.csproj"),
    readProjectFile("native-addin", "vsto", "NativeTaskPaneControl.cs"),
  ]);

  assert.doesNotMatch(`${script}\n${project}\n${pane}`, /localhost|TcpListener|HttpListener|node src\/server/i);
  assert.match(script, /Get-NetTCPConnection/);
});
