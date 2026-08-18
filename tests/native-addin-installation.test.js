import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readProjectFile(...segments) {
  return readFile(resolve(projectRoot, ...segments), "utf8");
}

test("原生加载项项目保持 x64 .NET Framework VSTO 和签名边界", async () => {
  const project = await readProjectFile("native-addin", "vsto", "ChatExcel.NativeVstoAddIn.csproj");
  const addin = await readProjectFile("native-addin", "vsto", "ThisAddIn.cs");
  const designer = await readProjectFile("native-addin", "vsto", "ThisAddIn.Designer.cs");

  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/);
  assert.match(project, /<OfficeApplication>Excel<\/OfficeApplication>/);
  assert.match(project, /Microsoft\.VisualStudio\.Tools\.Office\.targets/);
  assert.match(project, /Microsoft\.Office\.Tools\.Excel/);
  assert.match(project, /<SignManifests>true<\/SignManifests>/);
  assert.match(project, /<Target Name="BuildDeployment"/);
  assert.match(project, /DependsOnTargets="Compile;CopyFilesToOutputDirectory;VisualStudioForApplicationsBuild"/);
  assert.match(addin, /CustomTaskPanes\.Add\(taskPaneControl, TaskPaneTitle\)/);
  assert.match(designer, /Microsoft\.Office\.Tools\.AddInBase/);
  assert.match(designer, /if \(DataHost == null\)[\s\S]*?if \(DataHost\.IsCacheInitialized\)[\s\S]*?DataHost\.FillCachedData\(this\)/);
  assert.doesNotMatch(addin, /IDTExtensibility2|CreateCTP\(/);
  assert.doesNotMatch(addin, /localhost/i);
});

test("原生探针的任务窗格是 VSTO WinForms 控件且不启动网络服务", async () => {
  const pane = await readProjectFile("native-addin", "vsto", "NativeTaskPaneControl.cs");
  const ribbon = await readProjectFile("native-addin", "vsto", "NativeRibbon.cs");

  assert.match(pane, /sealed class NativeTaskPaneControl : UserControl/);
  assert.match(ribbon, /Microsoft\.Excel\.Workbook/);
  assert.match(ribbon, /SetTaskPaneVisible/);
  assert.doesNotMatch(pane, /localhost|TcpListener|HttpListener|CreateServer|WebView2/i);
});

test("当前用户 VSTO 安装脚本拒绝管理员和 SYSTEM，且不用裸 COM 注册", async () => {
  const script = await readProjectFile("scripts", "native-vsto-addin.ps1");

  assert.match(script, /HKCU:\\Software\\Microsoft\\Office\\Excel\\Addins\\ChatExcel\.NativeVstoAddIn/);
  assert.match(script, /IsSystem/);
  assert.match(script, /WindowsBuiltInRole\]::Administrator/);
  assert.match(script, /VSTOInstaller\.exe/);
  assert.match(script, /\/t:BuildDeployment/);
  assert.match(script, /Get-ChatExcelInstalledDeploymentUris/);
  assert.match(script, /\$expectedManifest = "\$\(Get-DeploymentManifestPath \$deploymentRoot\)\|vstolocal"/);
  assert.match(script, /\/Install/);
  assert.match(script, /\/Uninstall/);
  assert.match(script, /Cert:\\CurrentUser\\TrustedPublisher/);
  assert.doesNotMatch(script, /RegAsm\.exe|HKCU:\\Software\\Classes|HKLM:\\.*ChatExcel|Register-ScheduledTask|schtasks|New-Service/i);
});

test("原生安装脚本以 UTF-8 BOM 保存，供 Windows PowerShell 正确显示中文", async () => {
  const scriptBytes = await readFile(resolve(projectRoot, "scripts", "native-vsto-addin.ps1"));

  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});
