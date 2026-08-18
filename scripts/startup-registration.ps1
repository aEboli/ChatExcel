[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Install", "Uninstall", "Status")]
    [string]$Action,

    [string]$LauncherPath = "",

    [string]$RegistrySubKey = "Software\Microsoft\Windows\CurrentVersion\Run"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$valueName = "ChatExcel Local Service"
$defaultRegistrySubKey = "Software\Microsoft\Windows\CurrentVersion\Run"
$testRegistryPrefix = "Software\ChatExcel\Tests\"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Get-WindowsPowerShellPath {
    $candidate = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "未找到 Windows PowerShell 5.1：$candidate"
    }
    return [IO.Path]::GetFullPath($candidate)
}

function Get-StartupCommand {
    if (-not [string]::IsNullOrWhiteSpace($LauncherPath)) {
        $resolvedLauncher = [IO.Path]::GetFullPath($LauncherPath)
        if (-not (Test-Path -LiteralPath $resolvedLauncher -PathType Leaf) -or
            [IO.Path]::GetExtension($resolvedLauncher) -ine ".exe") {
            throw "ChatExcel Launcher 路径无效：$resolvedLauncher"
        }
        return '"' + $resolvedLauncher + '" --service-only'
    }

    $startScript = Join-Path $projectRoot "scripts\start.ps1"
    if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
        throw "找不到 ChatExcel 服务启动脚本：$startScript"
    }
    $powershellPath = Get-WindowsPowerShellPath
    return '"' + $powershellPath + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '"'
}

if ($RegistrySubKey -ine $defaultRegistrySubKey -and
    -not $RegistrySubKey.StartsWith($testRegistryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝写入 ChatExcel 允许范围以外的当前用户注册表路径：$RegistrySubKey"
}

$expectedCommand = Get-StartupCommand
$key = $null
$exitCode = 0
try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrySubKey)
    if ($null -eq $key) {
        throw "无法打开 ChatExcel 当前用户启动项注册表路径。"
    }
    $currentCommand = $key.GetValue(
        $valueName,
        $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $currentCommand) {
        $currentCommand = [string]$currentCommand
    }

    switch ($Action) {
        "Install" {
            $key.SetValue($valueName, $expectedCommand, [Microsoft.Win32.RegistryValueKind]::String)
            Write-Output "ChatExcel 当前用户登录启动项已登记。"
        }
        "Uninstall" {
            if ($null -eq $currentCommand) {
                Write-Output "未找到 ChatExcel 当前用户登录启动项，无需删除。"
            }
            elseif ([string]::Equals($currentCommand, $expectedCommand, [StringComparison]::Ordinal)) {
                $key.DeleteValue($valueName, $false)
                Write-Output "ChatExcel 当前项目登录启动项已删除。"
            }
            else {
                Write-Output "ChatExcel 登录启动项已由其他安装接管，当前项目未修改它。"
            }
        }
        "Status" {
            if ([string]::Equals($currentCommand, $expectedCommand, [StringComparison]::Ordinal)) {
                Write-Output "ChatExcel 当前用户登录启动项有效。"
            }
            else {
                Write-Output "ChatExcel 当前用户登录启动项缺失或不属于当前安装。"
                $exitCode = 1
            }
        }
    }
}
finally {
    if ($null -ne $key) {
        $key.Dispose()
    }
}

exit $exitCode
