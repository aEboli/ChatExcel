$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$runtimeDirectory = Join-Path $projectRoot ".runtime"
$pidPath = Join-Path $runtimeDirectory "service.pid"
$identityPath = Join-Path $runtimeDirectory "service.identity"
$supervisorPidPath = Join-Path $runtimeDirectory "service-supervisor.pid"
$supervisorScript = Join-Path $scriptDirectory "service-supervisor.ps1"
$stopPath = Join-Path $runtimeDirectory "service.stop"
$supervisorStdoutPath = Join-Path $runtimeDirectory "service-supervisor.stdout.log"
$supervisorStderrPath = Join-Path $runtimeDirectory "service-supervisor.stderr.log"
$servicePort = 3210
$serviceAddress = "127.0.0.1"
$healthUrl = "https://${serviceAddress}:$servicePort/api/health"
$serviceEntryPath = (Resolve-Path (Join-Path $projectRoot "src\server\index.js")).Path
$nodePath = (Resolve-Path (Get-Command node -ErrorAction Stop).Source).Path
$package = [IO.File]::ReadAllText((Join-Path $projectRoot "package.json"), [Text.Encoding]::UTF8) | ConvertFrom-Json
$expectedService = "ChatExcel"
$expectedVersion = [string]$package.version
$requiredCapabilities = @("office-addin", "native-xls")

function Get-Listener {
    Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq $serviceAddress } |
        Select-Object -First 1
}

function Test-Health {
    if ($null -eq (Get-Listener)) {
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

Write-Output "ChatExcel started with recovery monitoring: https://${serviceAddress}:$servicePort (PID $($tracked.Id))"
