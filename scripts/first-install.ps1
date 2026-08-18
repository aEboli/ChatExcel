[CmdletBinding()]
param(
    [ValidateSet("Menu", "Install", "Uninstall")]
    [string]$Action = "Menu"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dependencyStatePath = Join-Path $projectRoot "node_modules\.chatexcel-dependency-state"
$startupRegistrationScript = Join-Path $projectRoot "scripts\startup-registration.ps1"
$windowsPowerShellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$requiredDependencies = @(
    "node_modules\.package-lock.json",
    "node_modules\express\package.json",
    "node_modules\smol-toml\package.json",
    "node_modules\office-addin-dev-certs\package.json",
    "node_modules\office-addin-dev-certs\cli.js",
    "node_modules\office-addin-dev-settings\package.json",
    "node_modules\office-addin-manifest\package.json",
    "node_modules\.bin\office-addin-dev-certs.cmd",
    "node_modules\.bin\office-addin-manifest.cmd"
)

function Write-Stage([string]$message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Invoke-CheckedProcess(
    [string]$filePath,
    [string[]]$argumentList,
    [string]$failureMessage
) {
    & $filePath @argumentList
    $processExitCode = $LASTEXITCODE
    if ($processExitCode -ne 0) {
        throw "$failureMessage（退出码：$processExitCode）"
    }
}

function Get-FileSha256([string]$path) {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($path)
        $digest = $hasher.ComputeHash($stream)
        return ([BitConverter]::ToString($digest)).Replace("-", "")
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        $hasher.Dispose()
    }
}

function Get-DependencyState {
    $rootLockPath = Join-Path $projectRoot "package-lock.json"
    $installedLockPath = Join-Path $projectRoot "node_modules\.package-lock.json"
    if (-not (Test-Path -LiteralPath $rootLockPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installedLockPath -PathType Leaf)) {
        return $null
    }

    return "$(Get-FileSha256 $rootLockPath)`n$(Get-FileSha256 $installedLockPath)"
}

function Save-DependencyState {
    $state = Get-DependencyState
    if ([string]::IsNullOrWhiteSpace($state)) {
        throw "无法记录项目依赖状态。"
    }
    Set-Content -LiteralPath $dependencyStatePath -Value $state -Encoding ascii
}

function Test-ProjectDependencies([string]$npmPath) {
    foreach ($relativePath in $requiredDependencies) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
            return $false
        }
    }

    try {
        $recordedState = [IO.File]::ReadAllText($dependencyStatePath).Trim()
        $currentState = Get-DependencyState
    }
    catch {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace($currentState) -or $recordedState -ne $currentState) {
        return $false
    }

    $local:ErrorActionPreference = "Continue"
    & $npmPath ls --all --include=dev --silent *> $null
    return $LASTEXITCODE -eq 0
}

function Test-DevelopmentCertificate([string]$nodePath) {
    $local:ErrorActionPreference = "Continue"
    & $nodePath (Join-Path $projectRoot "scripts\verify-certs.mjs") *> $null
    return $LASTEXITCODE -eq 0
}

function Remove-ProjectDirectory([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        return
    }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "拒绝删除重解析点：$label。请先移除该目录链接。"
    }
    Remove-Item -LiteralPath $path -Recurse -Force
}

function Invoke-WithProjectMutex([scriptblock]$operation) {
    $mutex = $null
    $ownsMutex = $false
    try {
        $mutex = [Threading.Mutex]::new($false, "Local\ChatExcel.SourceFirstInstall")
        try {
            $ownsMutex = $mutex.WaitOne(0)
        }
        catch [Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
        if (-not $ownsMutex) {
            throw "另一个 ChatExcel 安装或卸载流程正在运行，请等待它完成后再试。"
        }
        & $operation
    }
    finally {
        if ($ownsMutex -and $null -ne $mutex) {
            $mutex.ReleaseMutex()
        }
        if ($null -ne $mutex) {
            $mutex.Dispose()
        }
    }
}

function Assert-InstallPrerequisites {
    if ($env:OS -ne "Windows_NT") {
        throw "初次安装启动器仅支持 Windows。"
    }
    foreach ($relativePath in @(
        "package.json",
        "package-lock.json",
        "manifest.xml",
        "scripts\start.ps1",
        "scripts\stop.ps1",
        "scripts\startup-registration.ps1",
        "scripts\service-supervisor.ps1",
        "scripts\sideload.mjs",
        "scripts\verify-certs.mjs",
        "src\server\index.js",
        "src\taskpane\taskpane.html"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
            throw "仓库缺少必要文件：$relativePath"
        }
    }
}

function Get-NodeTools {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand -or $null -eq $npmCommand) {
        throw "未找到 Node.js 或 npm。请先安装 Node.js 20 或更高版本，再重新双击此启动器。"
    }

    $nodePath = $nodeCommand.Source
    $npmPath = $npmCommand.Source
    $nodeVersion = ([string](& $nodePath --version)).Trim()
    [int]$nodeMajorVersion = 0
    $nodeMajorText = (($nodeVersion -replace '^v', '') -split '\.')[0]
    if (-not [int]::TryParse($nodeMajorText, [ref]$nodeMajorVersion) -or $nodeMajorVersion -lt 20) {
        throw "当前 Node.js 版本为 $nodeVersion；ChatExcel 需要 Node.js 20 或更高版本。"
    }

    return [PSCustomObject]@{
        NodePath = $nodePath
        NpmPath = $npmPath
        NodeVersion = $nodeVersion
    }
}

function Invoke-Install {
    Set-Location -LiteralPath $projectRoot
    Invoke-WithProjectMutex {
        Assert-InstallPrerequisites
        $tools = Get-NodeTools

        Write-Host "ChatExcel 安装/重装" -ForegroundColor Green
        Write-Host "项目目录：$projectRoot"
        Write-Host "Node.js：$($tools.NodeVersion)"

        $runtimeDirectory = Join-Path $projectRoot ".runtime"
        if (Test-Path -LiteralPath $runtimeDirectory -PathType Container) {
            Write-Stage "停止本项目的本地服务"
            Invoke-CheckedProcess "powershell.exe" @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $projectRoot "scripts\stop.ps1")
            ) "本地服务停止失败"
        }

        Write-Stage "按 package-lock.json 安装或重装项目依赖"
        Invoke-CheckedProcess $tools.NpmPath @("ci", "--no-audit", "--no-fund") "项目依赖安装失败"
        Save-DependencyState
        if (-not (Test-ProjectDependencies $tools.NpmPath)) {
            Remove-Item -LiteralPath $dependencyStatePath -Force -ErrorAction SilentlyContinue
            throw "项目依赖安装完成，但完整性检查仍未通过。"
        }

        if (-not (Test-DevelopmentCertificate $tools.NodePath)) {
            Write-Stage "安装并信任本地 HTTPS 开发证书"
            Write-Host "Windows 弹出证书信任提示时，请选择允许。"
            Invoke-CheckedProcess $tools.NpmPath @("run", "certs:install") "本地开发证书安装失败"
            if (-not (Test-DevelopmentCertificate $tools.NodePath)) {
                throw "证书安装完成，但验证仍未通过。请运行 npm run certs:verify 查看详情。"
            }
        }
        else {
            Write-Stage "本地 HTTPS 开发证书有效，跳过安装"
        }

        Write-Stage "校验 Office 加载项清单"
        Invoke-CheckedProcess $tools.NpmPath @("run", "validate:manifest") "Office 加载项清单校验失败"

        Write-Stage "启动本地服务并在 Microsoft Excel 中旁加载 ChatExcel"
        Invoke-CheckedProcess $tools.NpmPath @("run", "sideload") "Excel 加载项旁加载失败"

        Write-Stage "登记当前用户登录启动项"
        Invoke-CheckedProcess $windowsPowerShellPath @(
            "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", $startupRegistrationScript, "-Action", "Install"
        ) "ChatExcel 登录启动项登记失败"

        Write-Host ""
        Write-Host "ChatExcel 已启动。以后登录 Windows 后可直接从 Excel 加载项打开。" -ForegroundColor Green
    }
}

function Invoke-Uninstall {
    if ($env:OS -ne "Windows_NT") {
        throw "卸载启动器仅支持 Windows。"
    }

    Set-Location -LiteralPath $projectRoot
    Invoke-WithProjectMutex {
        $stopScript = Join-Path $projectRoot "scripts\stop.ps1"
        $runtimeDirectory = Join-Path $projectRoot ".runtime"
        $nodeModulesDirectory = Join-Path $projectRoot "node_modules"
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue

        Write-Host "ChatExcel 卸载" -ForegroundColor Yellow

        if ($null -ne (Get-Process -Name EXCEL -ErrorAction SilentlyContinue | Select-Object -First 1)) {
            throw "请先保存并关闭所有 Excel 窗口，再执行卸载。"
        }

        if (Test-Path -LiteralPath $runtimeDirectory -PathType Container) {
            if ($null -eq $nodeCommand) {
                throw "无法停止项目服务：未找到 Node.js。请恢复 Node.js 后重新执行卸载。"
            }
            Write-Stage "停止本项目的本地服务"
            Invoke-CheckedProcess "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $stopScript) "本地服务停止失败"
        }

        $registrationTool = Join-Path $projectRoot "node_modules\.bin\office-addin-dev-settings.cmd"
        if (Test-Path -LiteralPath $registrationTool -PathType Leaf) {
            if ($null -eq $npmCommand) {
                throw "无法注销 Excel 加载项：未找到 npm。请恢复 Node.js 后重新执行卸载。"
            }
            Write-Stage "注销 Excel 加载项"
            Invoke-CheckedProcess $npmCommand.Source @("run", "unregister") "Excel 加载项注销失败"
        }
        else {
            Write-Host "未找到已安装的加载项工具，跳过注销步骤。" -ForegroundColor DarkYellow
        }

        if (Test-Path -LiteralPath $nodeModulesDirectory -PathType Container) {
            Write-Stage "删除本项目依赖"
            Remove-ProjectDirectory $nodeModulesDirectory "node_modules"
        }
        Remove-Item -LiteralPath $dependencyStatePath -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $runtimeDirectory -PathType Container) {
            Remove-ProjectDirectory $runtimeDirectory ".runtime"
        }

        if (Test-Path -LiteralPath $startupRegistrationScript -PathType Leaf) {
            Write-Stage "移除当前项目登录启动项"
            Invoke-CheckedProcess $windowsPowerShellPath @(
                "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", $startupRegistrationScript, "-Action", "Uninstall"
            ) "ChatExcel 登录启动项移除失败"
        }

        Write-Host ""
        Write-Host "ChatExcel 已卸载：当前项目启动项、加载项注册、项目依赖和运行时文件已清除。" -ForegroundColor Green
        Write-Host "源代码和本地开发证书已保留。"
    }
}

function Invoke-SelectedAction([string]$title, [scriptblock]$operation) {
    try {
        & $operation
        return $true
    }
    catch {
        Write-Host ""
        Write-Host "${title}未完成" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        return $false
    }
}

function Start-LauncherMenu {
    while ($true) {
        Clear-Host
        Write-Host "ChatExcel 项目启动器" -ForegroundColor Green
        Write-Host ""
        Write-Host "1. 安装/重装该项目"
        Write-Host "2. 卸载该项目"
        Write-Host "3. 退出"
        Write-Host ""
        $selection = Read-Host "请输入数字"
        if ([string]::IsNullOrWhiteSpace($selection)) {
            return
        }
        $selection = $selection.Trim()

        switch ($selection) {
            "1" {
                [void](Invoke-SelectedAction "安装/重装" { Invoke-Install })
                [void](Read-Host "按 Enter 返回菜单")
            }
            "2" {
                [void](Invoke-SelectedAction "卸载" { Invoke-Uninstall })
                [void](Read-Host "按 Enter 返回菜单")
            }
            "3" {
                return
            }
            default {
                Write-Host "请输入 1、2 或 3。" -ForegroundColor Yellow
                Start-Sleep -Seconds 1
            }
        }
    }
}

if ($Action -eq "Menu") {
    Start-LauncherMenu
    exit 0
}

if ($Action -eq "Install") {
    if (Invoke-SelectedAction "安装/重装" { Invoke-Install }) {
        exit 0
    }
    exit 1
}

if (Invoke-SelectedAction "卸载" { Invoke-Uninstall }) {
    exit 0
}
exit 1
