$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$pidPath = Join-Path $runtimeDirectory "service.pid"
$supervisorPidPath = Join-Path $runtimeDirectory "service-supervisor.pid"
$supervisorScript = Join-Path $scriptDirectory "service-supervisor.ps1"
$stopPath = Join-Path $runtimeDirectory "service.stop"
$supervisorStdoutPath = Join-Path $runtimeDirectory "service-supervisor.stdout.log"
$supervisorStderrPath = Join-Path $runtimeDirectory "service-supervisor.stderr.log"
$servicePort = 3210
$healthUrl = "https://localhost:$servicePort/api/health"

function Get-Listener {
    Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Test-Health {
    if ($null -eq (Get-Listener)) {
        return $false
    }
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 1
        return $response.ok -eq $true
    }
    catch {
        return $false
    }
}

function Remove-ServicePid {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

function Get-TrackedService {
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return $null
    }

    $pidText = (Get-Content -Raw -LiteralPath $pidPath).Trim()
    $servicePid = 0
    if (-not [int]::TryParse($pidText, [ref]$servicePid)) {
        Remove-ServicePid
        return $null
    }

    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    if ($null -eq $process -or $process.ProcessName -ne "node") {
        Remove-ServicePid
        return $null
    }
    return $process
}

function Get-RunningSupervisor {
    if (-not (Test-Path -LiteralPath $supervisorPidPath)) {
        return $null
    }

    $lines = @(Get-Content -LiteralPath $supervisorPidPath -ErrorAction SilentlyContinue)
    $supervisorPid = 0
    $startTicks = 0L
    if ($lines.Count -lt 2 -or
        -not [int]::TryParse($lines[0], [ref]$supervisorPid) -or
        -not [long]::TryParse($lines[1], [ref]$startTicks)) {
        Remove-Item -LiteralPath $supervisorPidPath -Force -ErrorAction SilentlyContinue
        return $null
    }

    $process = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
    if ($null -eq $process -or $process.ProcessName -notin @("powershell", "pwsh")) {
        Remove-Item -LiteralPath $supervisorPidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    try {
        $actualStartTicks = $process.StartTime.ToUniversalTime().Ticks
    }
    catch {
        Remove-Item -LiteralPath $supervisorPidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    if ($actualStartTicks -ne $startTicks) {
        Remove-Item -LiteralPath $supervisorPidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    return $process
}

function Quote-ProcessArgument {
    param([string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-Supervisor {
    if (-not (Test-Path -LiteralPath $supervisorScript)) {
        throw "The local service supervisor script is missing: $supervisorScript"
    }

    Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $powershellPath)) {
        $powershellPath = "powershell.exe"
    }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (Quote-ProcessArgument $supervisorScript),
        "-ProjectRoot", (Quote-ProcessArgument $projectRoot),
        "-NodePath", (Quote-ProcessArgument $nodePath)
    ) -join " "

    return Start-Process `
        -FilePath $powershellPath `
        -ArgumentList $arguments `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $supervisorStdoutPath `
        -RedirectStandardError $supervisorStderrPath `
        -PassThru
}

function Wait-ForHealth {
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $tracked = Get-TrackedService
        $listener = Get-Listener
        if ($null -ne $tracked -and
            $null -ne $listener -and
            $listener.OwningProcess -eq $tracked.Id -and
            (Test-Health)) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue

$tracked = Get-TrackedService
$listener = Get-Listener
if ($null -ne $tracked -and ($null -eq $listener -or $listener.OwningProcess -ne $tracked.Id)) {
    Remove-ServicePid
    $tracked = $null
}
if ($null -ne $listener -and $null -eq $tracked) {
    throw "Port $servicePort is already owned by PID $($listener.OwningProcess). The project service was not started."
}

$supervisor = Get-RunningSupervisor
if ($null -eq $supervisor) {
    $supervisor = Start-Supervisor
}

if (-not (Wait-ForHealth)) {
    throw "The local service failed its HTTPS health check. Run npm run certs:install, then inspect .runtime/service.stderr.log and .runtime/service-supervisor.log."
}

$tracked = Get-TrackedService
$listener = Get-Listener
if ($null -eq $tracked -or $null -eq $listener -or $listener.OwningProcess -ne $tracked.Id) {
    throw "The local service passed health checks but is not owned by the project PID."
}

Write-Output "ChatExcel started with recovery monitoring: https://localhost:$servicePort (PID $($tracked.Id))"
