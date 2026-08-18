param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("build", "install", "diagnose", "uninstall")]
    [string]$Action,

    [switch]$CreateDevelopmentCertificate
)

$ErrorActionPreference = "Stop"

$addInId = "ChatExcel.NativeVstoAddIn"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$vstoProject = Join-Path $projectRoot "native-addin\vsto\ChatExcel.NativeVstoAddIn.csproj"
$buildDirectory = Join-Path $projectRoot "native-addin\vsto\bin\x64\Release"
$deploymentRoot = Join-Path $env:LOCALAPPDATA "ChatExcel\NativeVstoAddIn\0.1.0"
$deploymentManifestName = "$addInId.vsto"
$excelAddInPath = "HKCU:\Software\Microsoft\Office\Excel\Addins\ChatExcel.NativeVstoAddIn"
$vstoInstallerDefaultPath = Join-Path ${env:CommonProgramFiles} "Microsoft Shared\VSTO\10.0\VSTOInstaller.exe"
$msBuildDefaultPath = "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\amd64\MSBuild.exe"

function Write-Result([string]$message) {
    Write-Output "ChatExcel 原生 VSTO：$message"
}

function Assert-InteractiveUser {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.IsSystem -or [string]::Equals($env:USERNAME, "SYSTEM", [StringComparison]::OrdinalIgnoreCase)) {
        throw "原生 VSTO 加载项只允许当前交互用户操作，不能使用 SYSTEM。"
    }

    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "请以普通当前用户运行原生 VSTO 脚本；它只管理当前用户部署，不需要管理员权限。"
    }
}

function Test-ExcelRunning {
    return $null -ne (Get-Process -Name EXCEL -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Assert-ExcelStopped {
    if (Test-ExcelRunning) {
        throw "检测到 Excel 正在运行。请先保存并完全退出所有 Excel 窗口，再执行原生 VSTO $Action。"
    }
}

function Assert-ExcelX64 {
    $excelPath = "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE"
    if (-not (Test-Path -LiteralPath $excelPath)) {
        throw "未找到受支持的 64 位 Microsoft Excel：$excelPath"
    }

    $configuration = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration" -ErrorAction SilentlyContinue
    if ($configuration.Platform -ne "x64") {
        throw "当前 Excel 不是 x64，无法加载 x64 ChatExcel 原生 VSTO Add-in。"
    }
}

function Assert-NetFramework48 {
    $release = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" -ErrorAction Stop).Release
    if ($release -lt 528040) {
        throw "需要 .NET Framework 4.8 或更高版本。"
    }
}

function Get-VstoInstallerPath {
    if (Test-Path -LiteralPath $vstoInstallerDefaultPath) {
        return $vstoInstallerDefaultPath
    }

    $checkedPaths = New-Object System.Collections.Generic.List[string]
    foreach ($registryPath in @(
        "HKLM:\SOFTWARE\Microsoft\VSTO Runtime Setup\v4",
        "HKLM:\SOFTWARE\Wow6432Node\Microsoft\VSTO Runtime Setup\v4"
    )) {
        $installerPath = (Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue).InstallerPath
        if (-not [string]::IsNullOrWhiteSpace($installerPath)) {
            $checkedPaths.Add($installerPath)
            if (Test-Path -LiteralPath $installerPath) {
                return $installerPath
            }
        }
    }

    throw "未找到 Visual Studio Tools for Office Runtime 的 VSTOInstaller.exe：$vstoInstallerDefaultPath$($(if ($checkedPaths.Count -gt 0) { '；已检查：' + ($checkedPaths -join '，') } else { '' }))"
}

function Get-MSBuildPath {
    if (-not (Test-Path -LiteralPath $msBuildDefaultPath)) {
        throw "未找到 x64 Visual Studio MSBuild：$msBuildDefaultPath"
    }

    return $msBuildDefaultPath
}

function Get-DevelopmentCertificate {
    $certificates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
        $_.Subject -eq "CN=ChatExcel Native VSTO Development" -and
        $_.HasPrivateKey -and
        $_.NotAfter -gt [DateTime]::Now
    } | Sort-Object NotAfter -Descending)

    if ($certificates.Count -gt 0) {
        return $certificates[0]
    }

    if (-not $CreateDevelopmentCertificate) {
        throw "当前用户没有 ChatExcel 本地开发代码签名证书。开发探针请显式附加 -CreateDevelopmentCertificate；发行构建必须传入受控签名流程的证书。"
    }

    return New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=ChatExcel Native VSTO Development" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddYears(1)
}

function Ensure-DevelopmentPublisherTrusted([System.Security.Cryptography.X509Certificates.X509Certificate2]$certificate) {
    $trustedPublisherPath = "Cert:\CurrentUser\TrustedPublisher"
    $existing = @(Get-ChildItem -Path $trustedPublisherPath | Where-Object {
        $_.Thumbprint -eq $certificate.Thumbprint
    })
    if ($existing.Count -gt 0) {
        return
    }

    $publicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    )
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )

    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $store.Add($publicCertificate)
    } finally {
        $store.Close()
        $publicCertificate.Dispose()
    }
}

function Get-DeploymentManifestPath([string]$root) {
    return Join-Path $root $deploymentManifestName
}

function Assert-VstoPayload([string]$root) {
    foreach ($relativePath in @(
        "$addInId.dll",
        "$addInId.dll.manifest",
        $deploymentManifestName,
        "Microsoft.Office.Tools.Common.v4.0.Utilities.dll"
    )) {
        $path = Join-Path $root $relativePath
        if (-not (Test-Path -LiteralPath $path)) {
            throw "原生 VSTO 部署资源不完整：$path"
        }
    }
}

function Get-ChatExcelInclusionKeys {
    $root = "HKCU:\Software\Microsoft\VSTO\Security\Inclusion"
    if (-not (Test-Path -LiteralPath $root)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Where-Object {
        $url = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).Url
        -not [string]::IsNullOrWhiteSpace($url) -and $url -like "*ChatExcel.NativeVstoAddIn.vsto"
    })
}

function Get-ChatExcelInstalledDeploymentUris {
    $uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    if (-not (Test-Path -LiteralPath $uninstallRoot)) {
        return @()
    }

    $entries = Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue
    return @($entries | ForEach-Object {
        $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        if ($entry.DisplayName -eq $addInId -and -not [string]::IsNullOrWhiteSpace($entry.UrlUpdateInfo)) {
            [string]$entry.UrlUpdateInfo
        }
    } | Select-Object -Unique)
}

function Copy-VstoPayload {
    Assert-VstoPayload $buildDirectory
    New-Item -ItemType Directory -Path $deploymentRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $deploymentRoot -Force | Where-Object {
        -not $_.PSIsContainer -and $_.Name -in @(
            "$addInId.dll",
            "$addInId.dll.manifest",
            $deploymentManifestName,
            "Microsoft.Office.Tools.Common.v4.0.Utilities.dll"
        )
    } | Remove-Item -Force
    Copy-Item -LiteralPath (Join-Path $buildDirectory "$addInId.dll") -Destination $deploymentRoot -Force
    Copy-Item -LiteralPath (Join-Path $buildDirectory "$addInId.dll.manifest") -Destination $deploymentRoot -Force
    Copy-Item -LiteralPath (Join-Path $buildDirectory $deploymentManifestName) -Destination $deploymentRoot -Force
    Copy-Item -LiteralPath (Join-Path $buildDirectory "Microsoft.Office.Tools.Common.v4.0.Utilities.dll") -Destination $deploymentRoot -Force
    Assert-VstoPayload $deploymentRoot
}

function Invoke-VstoBuild {
    Assert-InteractiveUser
    Assert-ExcelX64
    Assert-NetFramework48
    if (-not (Test-Path -LiteralPath $vstoProject)) {
        throw "找不到原生 VSTO 项目：$vstoProject"
    }

    $certificate = Get-DevelopmentCertificate
    $msbuild = Get-MSBuildPath
    & $msbuild $vstoProject /t:BuildDeployment /p:Configuration=Release /p:Platform=x64 "/p:ManifestCertificateThumbprint=$($certificate.Thumbprint)" /v:minimal /nologo
    if ($LASTEXITCODE -ne 0) {
        throw "原生 VSTO 构建失败，退出码：$LASTEXITCODE"
    }

    Assert-VstoPayload $buildDirectory
    Write-Result "构建通过。"
}

function Invoke-VstoInstall {
    Assert-InteractiveUser
    Assert-ExcelStopped
    $certificate = Get-DevelopmentCertificate
    Ensure-DevelopmentPublisherTrusted $certificate
    Invoke-VstoBuild
    $installer = Get-VstoInstallerPath

    foreach ($installedUri in Get-ChatExcelInstalledDeploymentUris) {
        & $installer /Uninstall $installedUri /Silent
        if ($LASTEXITCODE -ne 0) {
            throw "VSTO Runtime 无法卸载已登记的 ChatExcel 部署：$installedUri（退出码：$LASTEXITCODE）"
        }
    }

    Copy-VstoPayload
    $manifestPath = Get-DeploymentManifestPath $deploymentRoot

    & $installer /Install $manifestPath /Silent
    if ($LASTEXITCODE -ne 0) {
        throw "VSTO Runtime 安装失败，退出码：$LASTEXITCODE"
    }

    $registration = Get-ItemProperty -LiteralPath $excelAddInPath -ErrorAction SilentlyContinue
    if ($null -eq $registration -or $registration.LoadBehavior -ne 3) {
        throw "VSTO Runtime 未创建 ChatExcel 当前用户 Excel Add-ins 注册。"
    }

    Write-Result "已安装到当前用户。请重新打开 Excel，然后在 ChatExcel 选项卡点击“打开 ChatExcel”。"
}

function Invoke-VstoUninstall {
    Assert-InteractiveUser
    Assert-ExcelStopped
    $installer = Get-VstoInstallerPath
    $installedUris = Get-ChatExcelInstalledDeploymentUris
    foreach ($installedUri in $installedUris) {
        & $installer /Uninstall $installedUri /Silent
        if ($LASTEXITCODE -ne 0) {
            throw "VSTO Runtime 卸载失败：$installedUri（退出码：$LASTEXITCODE）"
        }
    }

    foreach ($key in Get-ChatExcelInclusionKeys) {
        Remove-Item -LiteralPath $key.PSPath -Recurse -Force
    }

    if (Test-Path -LiteralPath $excelAddInPath) {
        $registration = Get-ItemProperty -LiteralPath $excelAddInPath -ErrorAction SilentlyContinue
        if (($registration.Manifest -as [string]) -like "*ChatExcel.NativeVstoAddIn.vsto*") {
            Remove-Item -LiteralPath $excelAddInPath -Recurse -Force
        }
    }

    Write-Result "已移除 ChatExcel 当前用户 VSTO 部署；旧 Office.js 侧载配置未修改。"
}

function Show-Diagnosis {
    $problems = New-Object System.Collections.Generic.List[string]
    try { Assert-InteractiveUser } catch { $problems.Add($_.Exception.Message) }
    try { Assert-ExcelX64 } catch { $problems.Add($_.Exception.Message) }
    try { Assert-NetFramework48 } catch { $problems.Add($_.Exception.Message) }
    try { [void](Get-VstoInstallerPath) } catch { $problems.Add($_.Exception.Message) }

    $manifestPath = Get-DeploymentManifestPath $deploymentRoot
    try { Assert-VstoPayload $deploymentRoot } catch { $problems.Add($_.Exception.Message) }

    $registration = Get-ItemProperty -LiteralPath $excelAddInPath -ErrorAction SilentlyContinue
    if ($null -eq $registration -or $registration.LoadBehavior -ne 3) {
        $problems.Add("未找到 ChatExcel 当前用户 Excel Add-ins VSTO 注册。")
    } else {
        $expectedManifest = "$(Get-DeploymentManifestPath $deploymentRoot)|vstolocal"
        if ([string]::Compare(($registration.Manifest -as [string]), $expectedManifest, [StringComparison]::OrdinalIgnoreCase) -ne 0) {
            $problems.Add("ChatExcel Excel Add-ins 注册未指向受控 VSTO 部署清单。")
        }
    }

    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3210 })
    if ($listeners.Count -gt 0) {
        Write-Warning "检测到 3210 正在被监听；原生 VSTO 探针不会使用它，这可能是旧 Office.js 服务。"
    }

    if ($problems.Count -gt 0) {
        $problems | ForEach-Object { Write-Output "缺口：$_" }
        exit 1
    }

    Write-Result "诊断通过：Excel=x64，VSTO=当前用户，加载行为=3；原生探针不需要 TCP listener。"
}

switch ($Action) {
    "build" { Invoke-VstoBuild }
    "install" { Invoke-VstoInstall }
    "diagnose" { Show-Diagnosis }
    "uninstall" { Invoke-VstoUninstall }
}
