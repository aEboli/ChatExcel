$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$pidPath = Join-Path $runtimeDirectory "service.pid"
$supervisorPidPath = Join-Path $runtimeDirectory "service-supervisor.pid"
$supervisorLockPath = Join-Path $runtimeDirectory "service-supervisor.lock"
$stopPath = Join-Path $runtimeDirectory "service.stop"
$servicePort = 3210

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

function Test-SupervisorLockHeld {
    if (-not (Test-Path -LiteralPath $supervisorLockPath)) {
        return $false
    }

    try {
        $lock = [IO.File]::Open(
            $supervisorLockPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None)
        $lock.Dispose()
        return $false
    }
    catch [IO.IOException] {
        return $true
    }
}

function Stop-ManagedSupervisor {
    $supervisor = Get-RunningSupervisor
    if ($null -eq $supervisor) {
        return
    }

    try {
        Stop-Process -Id $supervisor.Id -Force -ErrorAction Stop
    }
    catch {
        if ($null -ne (Get-Process -Id $supervisor.Id -ErrorAction SilentlyContinue)) {
            throw
        }
        return
    }
    Wait-Process -Id $supervisor.Id -Timeout 5 -ErrorAction SilentlyContinue
}

function Stop-TrackedService {
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return $false
    }

    $pidText = (Get-Content -Raw -LiteralPath $pidPath).Trim()
    $servicePid = 0
    if (-not [int]::TryParse($pidText, [ref]$servicePid)) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return $false
    }

    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    if ($process.ProcessName -ne "node") {
        throw "PID $servicePid is not a Node.js process. No process was stopped."
    }

    $listener = Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $servicePid } |
        Select-Object -First 1
    if ($null -eq $listener) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return $false
    }

    Stop-Process -Id $servicePid -ErrorAction Stop
    Wait-Process -Id $servicePid -Timeout 10 -ErrorAction SilentlyContinue
    if ($null -ne (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    return $true
}

if (-not (Test-Path -LiteralPath $runtimeDirectory)) {
    Write-Output "ChatExcel is not currently running from this project."
    exit 0
}

New-Item -ItemType File -Force -Path $stopPath | Out-Null
Stop-ManagedSupervisor

for ($attempt = 0; $attempt -lt 20 -and (Test-SupervisorLockHeld); $attempt += 1) {
    Start-Sleep -Milliseconds 250
}

$stopped = Stop-TrackedService
if (Test-SupervisorLockHeld) {
    throw "The local service supervisor did not stop. The stop marker was retained to prevent an automatic restart."
}

Remove-Item -LiteralPath $supervisorPidPath,$supervisorLockPath,$stopPath -Force -ErrorAction SilentlyContinue
if ($stopped) {
    Write-Output "ChatExcel service and recovery monitor stopped."
} else {
    Write-Output "ChatExcel recovery monitor stopped; no managed service was listening."
}
