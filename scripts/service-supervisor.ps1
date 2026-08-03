param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [Parameter(Mandatory = $true)]
    [string]$NodePath
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$nodePath = (Resolve-Path -LiteralPath $NodePath).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$pidPath = Join-Path $runtimeDirectory "service.pid"
$identityPath = Join-Path $runtimeDirectory "service.identity"
$supervisorPidPath = Join-Path $runtimeDirectory "service-supervisor.pid"
$supervisorLockPath = Join-Path $runtimeDirectory "service-supervisor.lock"
$stopPath = Join-Path $runtimeDirectory "service.stop"
$stdoutPath = Join-Path $runtimeDirectory "service.stdout.log"
$stderrPath = Join-Path $runtimeDirectory "service.stderr.log"
$logPath = Join-Path $runtimeDirectory "service-supervisor.log"
$servicePort = 3210
$serviceAddress = "127.0.0.1"
$healthUrl = "https://${serviceAddress}:$servicePort/api/health"
$serviceEntryPath = (Resolve-Path (Join-Path $projectRoot "src\server\index.js")).Path
$package = [IO.File]::ReadAllText((Join-Path $projectRoot "package.json"), [Text.Encoding]::UTF8) | ConvertFrom-Json
$expectedService = "ChatExcel"
$expectedVersion = [string]$package.version
$requiredCapabilities = @("office-addin", "native-xls")
$startupGracePeriod = [TimeSpan]::FromSeconds(8)
$healthFailureThreshold = 3
$maximumRecoveryDelaySeconds = 30
$script:lastStartAt = [DateTimeOffset]::MinValue
$script:nextRecoveryAt = [DateTimeOffset]::MinValue
$script:consecutiveHealthFailures = 0
$script:recoveryAttempt = 0
$script:nextDiagnosticAt = [DateTimeOffset]::MinValue

function Get-Listener {
    Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq $serviceAddress } |
        Select-Object -First 1
}

function Quote-ProcessArgument {
    param([string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Test-Health {
    param(
        [object]$Listener,
        [switch]$ListenerChecked
    )

    if (-not $ListenerChecked) {
        $Listener = Get-Listener
    }
    if ($null -eq $Listener) {
        return $false
    }
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 1
        if ($response.ok -ne $true -or
            $response.service -ne $expectedService -or
            $response.version -ne $expectedVersion) {
            return $false
        }
        $capabilities = @($response.capabilities)
        foreach ($requiredCapability in $requiredCapabilities) {
            if ($capabilities -notcontains $requiredCapability) {
                return $false
            }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Write-SupervisorLog {
    param([string]$Message)

    try {
        $line = "{0} {1}{2}" -f [DateTimeOffset]::Now.ToString("O"), $Message, [Environment]::NewLine
        [IO.File]::AppendAllText($logPath, $line, [Text.UTF8Encoding]::new($false))
    }
    catch {
        # Diagnostics must not prevent service recovery.
    }
}

function Remove-ServicePid {
    Remove-Item -LiteralPath $pidPath,$identityPath -Force -ErrorAction SilentlyContinue
}

function Get-TrackedService {
    if (-not (Test-Path -LiteralPath $pidPath)) {
        Remove-Item -LiteralPath $identityPath -Force -ErrorAction SilentlyContinue
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
    try {
        $actualStartTicks = $process.StartTime.ToUniversalTime().Ticks
        $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction Stop
        $actualNodePath = [string]$processInfo.ExecutablePath
        $commandLine = [string]$processInfo.CommandLine
    }
    catch {
        Remove-ServicePid
        return $null
    }
    $identity = @(Get-Content -LiteralPath $identityPath -ErrorAction SilentlyContinue)
    $startTicks = 0L
    if ($identity.Count -lt 3) {
        $listener = Get-Listener
        $pidRecordedAt = (Get-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue).LastWriteTimeUtc
        $pidMatchesStart = $null -ne $pidRecordedAt -and
            [Math]::Abs(($process.StartTime.ToUniversalTime() - $pidRecordedAt).TotalSeconds) -le 5
        $usesProjectEntry = $commandLine.IndexOf($serviceEntryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine -match 'src[\\/]server[\\/]index\.js'
        if ($null -eq $listener -or
            $listener.OwningProcess -ne $servicePid -or
            -not $pidMatchesStart -or
            $actualNodePath -ine $nodePath -or
            -not $usesProjectEntry) {
            Remove-ServicePid
            return $null
        }
        $identity = @($actualStartTicks, $actualNodePath, $serviceEntryPath)
        Set-Content -LiteralPath $identityPath -Value $identity -Encoding utf8
    }
    if (-not [long]::TryParse($identity[0], [ref]$startTicks)) {
        Remove-ServicePid
        return $null
    }
    $recordedNodePath = [string]$identity[1]
    $recordedEntryPath = [string]$identity[2]
    if ($actualStartTicks -ne $startTicks -or
        $actualNodePath -ine $recordedNodePath -or
        $recordedEntryPath -ine $serviceEntryPath -or
        $commandLine.IndexOf($recordedEntryPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Remove-ServicePid
        return $null
    }
    return $process
}

function Reset-RecoveryState {
    $script:lastStartAt = [DateTimeOffset]::MinValue
    $script:nextRecoveryAt = [DateTimeOffset]::MinValue
    $script:consecutiveHealthFailures = 0
    $script:recoveryAttempt = 0
}

function Schedule-Recovery {
    param([string]$Reason)

    $delaySeconds = [int][Math]::Min(
        $maximumRecoveryDelaySeconds,
        [Math]::Pow(2, [Math]::Min($script:recoveryAttempt + 1, 5)))
    $script:recoveryAttempt += 1
    $script:lastStartAt = [DateTimeOffset]::MinValue
    $script:consecutiveHealthFailures = 0
    $script:nextRecoveryAt = [DateTimeOffset]::UtcNow.AddSeconds($delaySeconds)
    Write-SupervisorLog "$Reason Recovery will retry in $delaySeconds seconds."
}

function Test-RecoveryDue {
    return [DateTimeOffset]::UtcNow -ge $script:nextRecoveryAt
}

function Start-TrackedService {
    param(
        [object]$Listener,
        [switch]$PortChecked
    )

    if (Test-Path -LiteralPath $stopPath) {
        return $false
    }

    if (-not (Test-RecoveryDue)) {
        return $false
    }

    if (-not $PortChecked) {
        $Listener = Get-Listener
    }
    if ($null -ne $Listener) {
        $now = [DateTimeOffset]::UtcNow
        if ($now -ge $script:nextDiagnosticAt) {
            Write-SupervisorLog "Port $servicePort is owned by PID $($Listener.OwningProcess); it was not adopted or stopped."
            $script:nextDiagnosticAt = $now.AddSeconds(10)
        }
        return $false
    }

    $process = Start-Process `
        -FilePath $nodePath `
        -ArgumentList @((Quote-ProcessArgument $serviceEntryPath)) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    try {
        $startedNodePath = [string]$process.Path
        if ([string]::IsNullOrWhiteSpace($startedNodePath)) {
            throw "The managed service executable path is unavailable."
        }
        $serviceIdentity = @(
            $process.StartTime.ToUniversalTime().Ticks,
            $startedNodePath,
            $serviceEntryPath
        )
        Set-Content -LiteralPath $identityPath -Value $serviceIdentity -Encoding utf8
        Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
    }
    catch {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Remove-ServicePid
        throw
    }
    $script:lastStartAt = [DateTimeOffset]::UtcNow
    $script:nextRecoveryAt = $script:lastStartAt.Add($startupGracePeriod)
    Write-SupervisorLog "Started ChatExcel service PID $($process.Id)."
    return $true
}

function Stop-UnhealthyTrackedService {
    param(
        [object]$Process,
        [object]$Listener
    )

    $process = $Process
    if ($null -eq $process) {
        return
    }

    if ($null -eq $Listener -or $Listener.OwningProcess -ne $process.Id) {
        Remove-ServicePid
        return
    }

    try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
        Write-SupervisorLog "Stopped unhealthy managed service PID $($process.Id)."
    }
    catch {
        Write-SupervisorLog "Could not stop managed service PID $($process.Id)."
    }
    finally {
        Remove-ServicePid
    }
}

function Set-SupervisorReference {
    $process = Get-Process -Id $PID -ErrorAction Stop
    $content = "$PID`n$($process.StartTime.ToUniversalTime().Ticks)"
    Set-Content -LiteralPath $supervisorPidPath -Value $content -Encoding ascii
}

function Clear-SupervisorReference {
    if (-not (Test-Path -LiteralPath $supervisorPidPath)) {
        return
    }

    $referencePid = 0
    $firstLine = (Get-Content -LiteralPath $supervisorPidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ([int]::TryParse($firstLine, [ref]$referencePid) -and $referencePid -eq $PID) {
        Remove-Item -LiteralPath $supervisorPidPath -Force -ErrorAction SilentlyContinue
    }
}

$lock = $null
try {
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    try {
        $lock = [IO.File]::Open(
            $supervisorLockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None)
    }
    catch [IO.IOException] {
        exit 0
    }

    Set-SupervisorReference
    Write-SupervisorLog "Service supervisor started."

    while (-not (Test-Path -LiteralPath $stopPath)) {
        $listener = Get-Listener
        $tracked = Get-TrackedService
        $listenerOwnedByTrackedService = $null -ne $tracked -and
            $null -ne $listener -and
            $listener.OwningProcess -eq $tracked.Id

        if ($listenerOwnedByTrackedService) {
            if (Test-Health -Listener $listener -ListenerChecked) {
                Reset-RecoveryState
                Start-Sleep -Milliseconds 500
                continue
            }

            if (-not (Test-RecoveryDue)) {
                Start-Sleep -Milliseconds 300
                continue
            }

            $script:consecutiveHealthFailures += 1
            if ($script:consecutiveHealthFailures -lt $healthFailureThreshold) {
                Start-Sleep -Milliseconds 500
                continue
            }

            Stop-UnhealthyTrackedService -Process $tracked -Listener $listener
            Schedule-Recovery "Managed service PID $($tracked.Id) remained unhealthy after $healthFailureThreshold health checks."
            Start-Sleep -Milliseconds 500
            continue
        }

        if ($null -ne $listener) {
            if ($null -ne $tracked) {
                # A stale PID must not give this project control over an unrelated listener.
                Remove-ServicePid
                Schedule-Recovery "Managed service PID $($tracked.Id) no longer owns port $servicePort."
            }
            [void](Start-TrackedService -Listener $listener -PortChecked)
            Start-Sleep -Milliseconds 500
            continue
        }

        if ($null -ne $tracked) {
            if (-not (Test-RecoveryDue)) {
                # Keep ownership through the startup grace period before judging a new process.
                Start-Sleep -Milliseconds 300
                continue
            }

            # Do not stop a Node process unless the project port confirms ownership.
            Remove-ServicePid
            Schedule-Recovery "Managed service PID $($tracked.Id) no longer listens on port $servicePort."
            Start-Sleep -Milliseconds 500
            continue
        }

        if ($script:lastStartAt -ne [DateTimeOffset]::MinValue) {
            if (-not (Test-RecoveryDue)) {
                Start-Sleep -Milliseconds 300
                continue
            }
            Schedule-Recovery "Managed service did not become healthy during its startup grace period."
            Start-Sleep -Milliseconds 500
            continue
        }

        if (-not (Test-Path -LiteralPath $stopPath)) {
            [void](Start-TrackedService -Listener $null -PortChecked)
        }
        Start-Sleep -Milliseconds 500
    }

    Write-SupervisorLog "Explicit stop marker detected; service supervisor exiting."
}
catch {
    Write-SupervisorLog "Service supervisor exited unexpectedly."
}
finally {
    Clear-SupervisorReference
    if ($null -ne $lock) {
        $lock.Dispose()
    }
}
