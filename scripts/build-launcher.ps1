param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$launcherProject = Join-Path $projectRoot "launcher\ChatExcelLauncher.csproj"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $nodePath --version).Trim()
if ([version]($nodeVersion.TrimStart("v")) -lt [version]"20.0.0") {
    throw "ChatExcel Launcher 需要 Node.js 20 或更高版本。"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "dist"
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$releaseRoot = Join-Path $outputRoot "ChatExcel Launcher"
$appRoot = Join-Path $releaseRoot "app"
$publishRoot = Join-Path $projectRoot "work\launcher-publish"
$packageJson = @'
{
  "name": "chatexcel-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "express": "5.2.1",
    "smol-toml": "1.7.1",
    "office-addin-dev-certs": "2.0.10",
    "office-addin-dev-settings": "3.1.2",
    "office-addin-manifest": "2.1.6"
  }
}
'@

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $releaseRoot) {
    $resolvedOutputRoot = (Resolve-Path $outputRoot).Path
    $resolvedReleaseRoot = [IO.Path]::GetFullPath($releaseRoot)
    if (-not $resolvedReleaseRoot.StartsWith($resolvedOutputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "发行目录不在输出目录内，拒绝清理。"
    }
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
if (Test-Path -LiteralPath $publishRoot) { Remove-Item -LiteralPath $publishRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appRoot,(Join-Path $appRoot "runtime"),$publishRoot | Out-Null

dotnet publish $launcherProject `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $publishRoot `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None `
    -p:DebugSymbols=false

$publishedLauncher = Join-Path $publishRoot "ChatExcel Launcher.exe"
if (-not (Test-Path -LiteralPath $publishedLauncher)) {
    throw "未生成 ChatExcel Launcher.exe。"
}
Copy-Item -LiteralPath $publishedLauncher -Destination (Join-Path $releaseRoot "ChatExcel Launcher.exe") -Force

foreach ($directory in @("assets", "scripts", "src")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $appRoot -Recurse -Force
}
foreach ($file in @("manifest.xml", "README.md", "README.zh-CN.md")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $appRoot -Force
}
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $appRoot "runtime\node.exe") -Force
[IO.File]::WriteAllText((Join-Path $appRoot "package.json"), $packageJson, [Text.UTF8Encoding]::new($false))

Push-Location $appRoot
try {
    npm install --no-package-lock --ignore-scripts --no-audit --no-fund --omit=optional --legacy-peer-deps
}
finally {
    Pop-Location
}

$metadata = [ordered]@{
    name = "ChatExcel Launcher"
    version = "0.0.1"
    architecture = "win-x64"
    node = $nodeVersion
    builtAt = [DateTimeOffset]::Now.ToString("O")
}
[IO.File]::WriteAllText((Join-Path $releaseRoot "release.json"), ($metadata | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

Write-Output "ChatExcel Launcher 已生成：$releaseRoot"
