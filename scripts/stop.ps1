$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$pidPath = Join-Path $runtimeDirectory "service.pid"
$servicePort = 3210

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output "ChatExcel is not currently running from this project."
    exit 0
}

$pidText = (Get-Content -Raw -LiteralPath $pidPath).Trim()
$servicePid = 0
if (-not [int]::TryParse($pidText, [ref]$servicePid)) {
    throw "The project PID file is invalid. No process was stopped."
}

$process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Remove-Item -LiteralPath $pidPath -Force
    Write-Output "The project service no longer exists. The stale PID file was removed."
    exit 0
}

if ($process.ProcessName -ne "node") {
    throw "PID $servicePid is not a Node.js process. No process was stopped."
}

$listener = Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $servicePid } |
    Select-Object -First 1
if ($null -eq $listener) {
    throw "PID $servicePid is not listening on project port $servicePort. No process was stopped."
}

Stop-Process -Id $servicePid
Wait-Process -Id $servicePid -Timeout 10 -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidPath -Force
Write-Output "ChatExcel stopped (PID $servicePid)."
