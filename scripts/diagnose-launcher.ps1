param()

$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$launcherPath = Join-Path $projectRoot "dist\ChatExcel Launcher\ChatExcel Launcher.exe"
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "未找到发行版启动器，请先运行 npm run build:launcher。"
}
$process = Start-Process -FilePath $launcherPath -ArgumentList @("--diagnose") -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
