param()

$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$startScript = Join-Path $scriptDirectory "start.ps1"
$stopScript = Join-Path $scriptDirectory "stop.ps1"
$servicePidPath = Join-Path $runtimeDirectory "service.pid"
$supervisorPidPath = Join-Path $runtimeDirectory "service-supervisor.pid"
$stopPath = Join-Path $runtimeDirectory "service.stop"
$probeProgramPath = Join-Path $runtimeDirectory "service-recovery-probe.cjs"
$probeStdoutPath = Join-Path $runtimeDirectory "service-recovery-probe.stdout.log"
$probeStderrPath = Join-Path $runtimeDirectory "service-recovery-probe.stderr.log"
$serviceAddress = "127.0.0.1"
$servicePort = 3210
$healthUrl = "https://${serviceAddress}:$servicePort/api/health"
$nodePath = (Get-Command node -ErrorAction Stop).Source

function Get-Listener {
    Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Get-ManagedService {
    if (-not (Test-Path -LiteralPath $servicePidPath)) {
        return $null
    }

    $pidText = (Get-Content -Raw -LiteralPath $servicePidPath).Trim()
    $servicePid = 0
    if (-not [int]::TryParse($pidText, [ref]$servicePid)) {
        return $null
    }

    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    if ($null -eq $process -or $process.ProcessName -ne "node") {
        return $null
    }

    $listener = Get-Listener
    if ($null -eq $listener -or $listener.OwningProcess -ne $process.Id) {
        return $null
    }

    return $process
}

function Test-ServiceHealth {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        return $response.ok -eq $true
    }
    catch {
        return $false
    }
}

function Invoke-ProjectScript {
    param([string]$Path)

    $global:LASTEXITCODE = 0
    try {
        $output = @(& $Path 2>&1)
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) {
            $exitCode = 0
        }
    }
    catch {
        $output = @($_)
        $exitCode = 1
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = ($output | Out-String).Trim()
    }
}

function Wait-For {
    param(
        [scriptblock]$Condition,
        [int]$Attempts = 60,
        [int]$DelayMilliseconds = 500
    )

    for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
        if (& $Condition) {
            return $true
        }
        Start-Sleep -Milliseconds $DelayMilliseconds
    }
    return $false
}

function Stop-ProcessIfRunning {
    param([Diagnostics.Process]$Process)

    if ($null -ne $Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $Process.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
}

$probe = $null
$managedServiceStarted = $false
$script:recoveredPid = 0
try {
    $listener = Get-Listener
    if ($null -ne $listener -or
        (Test-Path -LiteralPath $servicePidPath) -or
        (Test-Path -LiteralPath $supervisorPidPath) -or
        (Test-Path -LiteralPath $stopPath)) {
        throw "Service recovery smoke test requires an idle project runtime and port $servicePort."
    }

    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    [IO.File]::WriteAllText(
        $probeProgramPath,
        "const net = require('node:net'); net.createServer().listen(3210, '127.0.0.1'); setInterval(() => {}, 1000);",
        [Text.UTF8Encoding]::new($false))
    $probe = Start-Process `
        -FilePath $nodePath `
        -ArgumentList @($probeProgramPath) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $probeStdoutPath `
        -RedirectStandardError $probeStderrPath `
        -PassThru
    if (-not (Wait-For -Attempts 20 -DelayMilliseconds 250 -Condition {
        $probeListener = Get-Listener
        $null -ne $probeListener -and $probeListener.OwningProcess -eq $probe.Id
    })) {
        throw "The temporary external listener did not claim port $servicePort."
    }

    $rejectedStart = Invoke-ProjectScript -Path $startScript
    if ($rejectedStart.ExitCode -eq 0) {
        throw "The project start script accepted an external listener."
    }
    $listener = Get-Listener
    if ($null -eq $listener -or $listener.OwningProcess -ne $probe.Id -or $probe.HasExited) {
        throw "The project start script altered the external listener."
    }
    if ((Test-Path -LiteralPath $servicePidPath) -or (Test-Path -LiteralPath $supervisorPidPath)) {
        throw "The project start script wrote managed runtime state while rejecting an external listener."
    }

    Stop-ProcessIfRunning -Process $probe
    $probe = $null
    if (-not (Wait-For -Attempts 20 -DelayMilliseconds 250 -Condition { $null -eq (Get-Listener) })) {
        throw "The temporary external listener did not release port $servicePort."
    }

    $started = Invoke-ProjectScript -Path $startScript
    if ($started.ExitCode -ne 0) {
        throw "The project service did not start (exit $($started.ExitCode)): $($started.Output)"
    }
    $managedService = Get-ManagedService
    if ($null -eq $managedService -or -not (Test-ServiceHealth)) {
        throw "The project service did not become healthy with matching PID and port ownership."
    }
    $managedServiceStarted = $true
    $previousPid = $managedService.Id

    Stop-Process -Id $previousPid -Force -ErrorAction Stop
    if (-not (Wait-For -Attempts 90 -DelayMilliseconds 500 -Condition {
        $candidate = Get-ManagedService
        if ($null -eq $candidate -or $candidate.Id -eq $previousPid -or -not (Test-ServiceHealth)) {
            return $false
        }
        $script:recoveredPid = $candidate.Id
        return $true
    })) {
        throw "The managed service did not recover within 45 seconds."
    }

    $stopped = Invoke-ProjectScript -Path $stopScript
    if ($stopped.ExitCode -ne 0) {
        throw "The project service did not stop cleanly: $($stopped.Output)"
    }
    $managedServiceStarted = $false
    Start-Sleep -Seconds 3
    if ($null -ne (Get-Listener) -or
        (Test-Path -LiteralPath $servicePidPath) -or
        (Test-Path -LiteralPath $supervisorPidPath) -or
        (Test-Path -LiteralPath $stopPath)) {
        throw "Explicit stop left a listener or project runtime marker behind."
    }

    [pscustomobject]@{
        ExternalListenerPreserved = $true
        PreviousManagedPid = $previousPid
        RecoveredManagedPid = $script:recoveredPid
        ExplicitStopPreventedRestart = $true
    } | ConvertTo-Json -Compress
}
finally {
    Stop-ProcessIfRunning -Process $probe
    if ($managedServiceStarted -or
        (Test-Path -LiteralPath $servicePidPath) -or
        (Test-Path -LiteralPath $supervisorPidPath)) {
        try { [void](Invoke-ProjectScript -Path $stopScript) } catch { }
    }
    Remove-Item `
        -LiteralPath $probeProgramPath,$probeStdoutPath,$probeStderrPath `
        -Force `
        -ErrorAction SilentlyContinue
}
