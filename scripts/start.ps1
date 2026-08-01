$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$pidPath = Join-Path $runtimeDirectory "service.pid"
$stdoutPath = Join-Path $runtimeDirectory "service.stdout.log"
$stderrPath = Join-Path $runtimeDirectory "service.stderr.log"
$servicePort = 3210
$healthUrl = "https://localhost:$servicePort/api/health"

function Get-Listener {
    Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Test-Health {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        return $response.ok -eq $true
    }
    catch {
        return $false
    }
}

if (Test-Path -LiteralPath $pidPath) {
    $pidText = (Get-Content -Raw -LiteralPath $pidPath).Trim()
    $servicePid = 0
    if ([int]::TryParse($pidText, [ref]$servicePid)) {
        $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
        $listener = Get-Listener
        if ($null -ne $process -and $process.ProcessName -eq "node" -and $listener.OwningProcess -eq $servicePid) {
            if (-not (Test-Health)) {
                throw "The project service is listening, but its HTTPS health check failed. Check the development certificate and .runtime/service.stderr.log."
            }
            Write-Output "ChatExcel is already running: $healthUrl (PID $servicePid)"
            exit 0
        }
    }
    Remove-Item -LiteralPath $pidPath -Force
}

$occupied = Get-Listener
if ($null -ne $occupied) {
    throw "Port $servicePort is already owned by PID $($occupied.OwningProcess). The project service was not started."
}

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList @("src/server/index.js") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) {
        break
    }
    if (Test-Health) {
        $healthy = $true
        break
    }
}

if (-not $healthy) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    throw "The local service failed its HTTPS health check. Run npm run certs:install, then inspect .runtime/service.stderr.log."
}

Write-Output "ChatExcel started: https://localhost:$servicePort (PID $($process.Id))"
