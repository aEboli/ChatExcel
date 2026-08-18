param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("build", "install", "diagnose", "uninstall")]
    [string]$Action,

    [string]$InstallDirectory = ""
)

$ErrorActionPreference = "Stop"

$addinProgId = "ChatExcel.NativeAddIn"
$addinGuid = "{A7758431-BB7D-48E2-BE82-E4DC54E8541B}"
$paneGuid = "{487CEEAC-7E39-4F05-8F50-C1A468ACABFC}"
$managedCategoryGuid = "{62C8FE65-4EBB-45E7-B440-6E39B2CDBF29}"
$addinRegistryPath = "HKCU:\Software\Microsoft\Office\Excel\Addins\$addinProgId"
$classesRoot = "HKCU:\Software\Classes"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nativeProject = Join-Path $projectRoot "native-addin\ChatExcel.NativeAddIn.csproj"
$defaultBuildDirectory = Join-Path $projectRoot "native-addin\bin\x64\Release\net48"
$defaultInstallDirectory = Join-Path $env:LOCALAPPDATA "ChatExcel\NativeAddIn\0.1.0"
$excelPath = "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE"

function Write-Result([string]$message) {
    Write-Output "ChatExcel 原生加载项：$message"
}

function Assert-InteractiveUser {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.IsSystem -or [string]::Equals($env:USERNAME, "SYSTEM", [StringComparison]::OrdinalIgnoreCase)) {
        throw "原生加载项只允许当前交互用户安装，不能使用 SYSTEM。"
    }
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "请以普通当前用户运行原生加载项脚本；它只写入 HKCU，不需要管理员权限。"
    }
}

function Assert-ExcelX64 {
    if (-not (Test-Path -LiteralPath $excelPath)) {
        throw "未找到受支持的 64 位 Microsoft Excel：$excelPath"
    }
    $configuration = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration" -ErrorAction SilentlyContinue
    if ($configuration.Platform -ne "x64") {
        throw "当前 Excel 不是 x64，无法加载 x64 ChatExcel 原生加载项。"
    }
}

function Find-WebView2Runtime {
    $roots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    ) | Select-Object -Unique

    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root)) {
            continue
        }

        $applicationDirectory = Join-Path $root "Microsoft\EdgeWebView\Application"
        $runtime = Get-ChildItem -LiteralPath $applicationDirectory -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "msedgewebview2.exe") } |
            Select-Object -First 1
        if ($null -ne $runtime) {
            return $runtime.FullName
        }
    }

    return $null
}

function Assert-Prerequisites {
    Assert-InteractiveUser
    Assert-ExcelX64
    $release = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" -ErrorAction Stop).Release
    if ($release -lt 528040) {
        throw "需要 .NET Framework 4.8 或更高版本。"
    }
    if ($null -eq (Find-WebView2Runtime)) {
        throw "未找到 Microsoft Edge WebView2 Runtime。请安装 Evergreen Runtime 后重试。"
    }
}

function Invoke-NativeBuild {
    if (-not (Test-Path -LiteralPath $nativeProject)) {
        throw "找不到原生加载项项目：$nativeProject"
    }
    & dotnet build $nativeProject --configuration Release -p:Platform=x64 --nologo
    if ($LASTEXITCODE -ne 0) {
        throw "原生加载项构建失败，退出码：$LASTEXITCODE"
    }
}

function Get-InstallDirectory {
    if ([string]::IsNullOrWhiteSpace($InstallDirectory)) {
        return $defaultInstallDirectory
    }
    $candidate = [IO.Path]::GetFullPath($InstallDirectory)
    $localRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "ChatExcel"))
    if (-not $candidate.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "安装目录必须位于当前用户的 $localRoot 下。"
    }
    return $candidate
}

function Get-AssemblyPath([string]$directory) {
    $assemblyPath = Join-Path $directory "ChatExcel.NativeAddIn.dll"
    if (-not (Test-Path -LiteralPath $assemblyPath)) {
        throw "找不到原生加载项程序集：$assemblyPath"
    }
    return $assemblyPath
}

function Assert-NativePayload([string]$directory) {
    foreach ($relativePath in @(
        "ChatExcel.NativeAddIn.dll",
        "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.WinForms.dll",
        "WebView2Loader.dll",
        "web\index.html",
        "web\style.css"
    )) {
        $path = Join-Path $directory $relativePath
        if (-not (Test-Path -LiteralPath $path)) {
            throw "原生加载项资源不完整：$path"
        }
    }
}

function Remove-ChatExcelRegistration {
    foreach ($path in @(
        "$classesRoot\CLSID\$addinGuid",
        "$classesRoot\CLSID\$paneGuid",
        "$classesRoot\$addinProgId",
        "$classesRoot\ChatExcel.NativeTaskPane",
        $addinRegistryPath
    )) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
}

function Set-DefaultRegistryValue([string]$path, [string]$value) {
    if (-not $path.StartsWith("HKCU:\Software\Classes\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝写入 ChatExcel 当前用户 Classes 范围以外的注册表路径：$path"
    }
    $subKeyPath = $path.Substring("HKCU:\".Length)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKeyPath)
    if ($null -eq $key) {
        throw "无法打开 ChatExcel 当前用户注册表路径：$path"
    }
    try {
        # An empty value name is the real registry default value, not a value literally named "(default)".
        $key.SetValue("", $value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $key.Dispose()
    }
}

function Set-ComRegistration([string]$assemblyPath) {
    $assemblyName = [Reflection.AssemblyName]::GetAssemblyName($assemblyPath)
    if ($assemblyName.Name -ne "ChatExcel.NativeAddIn" -or [string]::IsNullOrWhiteSpace($assemblyName.FullName)) {
        throw "ChatExcel 原生程序集标识无效。"
    }
    $codeBase = ([Uri]$assemblyPath).AbsoluteUri
    $types = @(
        [ordered]@{ Guid = $addinGuid; ProgId = $addinProgId; Class = "ChatExcel.NativeAddIn.ChatExcelAddIn" },
        [ordered]@{ Guid = $paneGuid; ProgId = "ChatExcel.NativeTaskPane"; Class = "ChatExcel.NativeAddIn.NativeTaskPaneControl" }
    )
    foreach ($type in $types) {
        $classPath = "$classesRoot\CLSID\$($type.Guid)"
        $serverPath = "$classPath\InprocServer32"
        $versionPath = "$serverPath\$($assemblyName.Version)"
        $progIdPath = "$classesRoot\$($type.ProgId)"
        New-Item -Path $serverPath -Force | Out-Null
        Set-DefaultRegistryValue $classPath $type.Class
        Set-DefaultRegistryValue $serverPath "mscoree.dll"
        New-ItemProperty -LiteralPath $serverPath -Name "ThreadingModel" -Value "Both" -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $serverPath -Name "Class" -Value $type.Class -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $serverPath -Name "Assembly" -Value $assemblyName.FullName -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $serverPath -Name "RuntimeVersion" -Value "v4.0.30319" -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $serverPath -Name "CodeBase" -Value $codeBase -PropertyType String -Force | Out-Null

        New-Item -Path $versionPath -Force | Out-Null
        New-ItemProperty -LiteralPath $versionPath -Name "Class" -Value $type.Class -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $versionPath -Name "Assembly" -Value $assemblyName.FullName -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $versionPath -Name "RuntimeVersion" -Value "v4.0.30319" -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $versionPath -Name "CodeBase" -Value $codeBase -PropertyType String -Force | Out-Null

        New-Item -Path "$classPath\ProgId" -Force | Out-Null
        Set-DefaultRegistryValue "$classPath\ProgId" $type.ProgId
        New-Item -Path "$classPath\Implemented Categories\$managedCategoryGuid" -Force | Out-Null

        New-Item -Path "$progIdPath\CLSID" -Force | Out-Null
        Set-DefaultRegistryValue $progIdPath $type.Class
        Set-DefaultRegistryValue "$progIdPath\CLSID" $type.Guid
    }
}

function Install-NativeAddIn {
    Assert-Prerequisites
    Invoke-NativeBuild
    $destination = Get-InstallDirectory
    $source = $defaultBuildDirectory
    if (-not (Test-Path -LiteralPath $source)) {
        throw "构建输出不存在：$source"
    }

    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source "ChatExcel.NativeAddIn.dll") -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $source "Microsoft.Web.WebView2.Core.dll") -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $source "Microsoft.Web.WebView2.WinForms.dll") -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $source "WebView2Loader.dll") -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $source "web") -Destination $destination -Recurse -Force

    Assert-NativePayload $destination
    $assemblyPath = Get-AssemblyPath $destination
    Remove-ChatExcelRegistration
    Set-ComRegistration $assemblyPath

    New-Item -Path $addinRegistryPath -Force | Out-Null
    New-ItemProperty -LiteralPath $addinRegistryPath -Name "FriendlyName" -Value "ChatExcel Native Add-in" -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $addinRegistryPath -Name "Description" -Value "ChatExcel 无 TCP 原生 Excel 任务窗格" -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $addinRegistryPath -Name "LoadBehavior" -Value 3 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -LiteralPath $addinRegistryPath -Name "CommandLineSafe" -Value 0 -PropertyType DWord -Force | Out-Null

    Write-Result "已为当前用户安装。请完全退出并重新打开 Excel，然后在 ChatExcel 选项卡点击“打开 ChatExcel”。"
}

function Show-Diagnosis {
    $problems = New-Object System.Collections.Generic.List[string]
    try { Assert-Prerequisites } catch { $problems.Add($_.Exception.Message) }
    $registration = Get-ItemProperty -LiteralPath $addinRegistryPath -ErrorAction SilentlyContinue
    $assemblyCodeBase = $null
    $paneCategoryPath = "Registry::HKEY_CURRENT_USER\Software\Classes\CLSID\$paneGuid\Implemented Categories\$managedCategoryGuid"
    try {
        $registrationKey = "Registry::HKEY_CURRENT_USER\Software\Classes\CLSID\$addinGuid\InprocServer32"
        $assemblyCodeBase = (Get-ItemProperty -LiteralPath $registrationKey -ErrorAction Stop).CodeBase
    } catch { $problems.Add("未找到 ChatExcel 当前用户 COM 注册。") }
    if ([string]::IsNullOrWhiteSpace($assemblyCodeBase) -or -not $assemblyCodeBase.StartsWith("file:", [StringComparison]::OrdinalIgnoreCase)) {
        $problems.Add("ChatExcel COM 注册缺少有效的程序集 CodeBase。")
    } else {
        try {
            $assemblyUri = [Uri]$assemblyCodeBase
            Assert-NativePayload (Split-Path -Parent $assemblyUri.LocalPath)
        } catch {
            $problems.Add($_.Exception.Message)
        }
    }
    if (-not (Test-Path -LiteralPath $paneCategoryPath)) {
        $problems.Add("ChatExcel 任务窗格 ActiveX 类别注册不完整。")
    }
    if ($null -eq $registration -or $registration.LoadBehavior -ne 3) {
        $problems.Add("未找到 ChatExcel Excel Addins 当前用户注册。")
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
        $_.LocalPort -eq 3210
    })
    if ($listeners.Count -gt 0) {
        Write-Warning "检测到 3210 正在被监听；原生加载项不会使用它，但这可能是旧 Office.js 服务。"
    }
    if ($problems.Count -gt 0) {
        $problems | ForEach-Object { Write-Output "缺口：$_" }
        exit 1
    }
    Write-Result "诊断通过：Excel=x64，注册=HKCU，加载行为=3，原生入口不需要 TCP listener。"
}

switch ($Action) {
    "build" { Invoke-NativeBuild; Write-Result "构建通过。" }
    "install" { Install-NativeAddIn }
    "diagnose" { Show-Diagnosis }
    "uninstall" {
        Assert-InteractiveUser
        Remove-ChatExcelRegistration
        Write-Result "已移除当前用户的 ChatExcel 原生加载项注册；旧 Office.js 侧载配置未修改。"
    }
}
