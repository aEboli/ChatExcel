param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$packageJsonPath = Join-Path $projectRoot "package.json"
$package = [IO.File]::ReadAllText($packageJsonPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$releaseVersion = [string]$package.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "package.json version must use MAJOR.MINOR.PATCH; current version is $releaseVersion."
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "dist"
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$buildScript = Join-Path $projectRoot "scripts\build-launcher.ps1"
& $buildScript -OutputDirectory $outputRoot
if ($LASTEXITCODE -ne 0) {
    throw "Launcher build failed; release packaging cannot continue."
}
$releaseRoot = Join-Path $outputRoot "ChatExcel Launcher"
$releaseDirectory = Join-Path $outputRoot "releases"
$zipName = "ChatExcel-Launcher-$releaseVersion-win-x64.zip"
$zipPath = Join-Path $releaseDirectory $zipName
$hashPath = "$zipPath.sha256"

if (-not (Test-Path -LiteralPath $releaseRoot)) {
    throw "Release directory was not found. Run build:launcher first."
}
$requiredFiles = @(
    (Join-Path $releaseRoot "ChatExcel Launcher.exe"),
    (Join-Path $releaseRoot "release.json"),
    (Join-Path $releaseRoot "app")
)
foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Release directory is missing required content: $requiredFile"
    }
}

New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
$resolvedOutputRoot = (Resolve-Path $outputRoot).Path
$resolvedReleaseDirectory = [IO.Path]::GetFullPath($releaseDirectory)
if (-not $resolvedReleaseDirectory.StartsWith($resolvedOutputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Archive output directory is outside dist; refusing to overwrite."
}
foreach ($artifact in @($zipPath, $hashPath)) {
    if (Test-Path -LiteralPath $artifact) {
        [IO.File]::Delete($artifact)
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
    $releaseRoot,
    $zipPath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
)
if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "Release ZIP was not generated."
}

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $zipStream = [IO.File]::OpenRead($zipPath)
    try {
        $hash = ([BitConverter]::ToString($sha256.ComputeHash($zipStream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $zipStream.Dispose()
    }
}
finally {
    $sha256.Dispose()
}
"$hash  $zipName" | Set-Content -LiteralPath $hashPath -Encoding ascii

$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
    foreach ($requiredEntry in @("ChatExcel Launcher.exe", "release.json", "app/")) {
        if (-not ($entryNames -contains $requiredEntry) -and $requiredEntry -ne "app/") {
            throw "Release ZIP is missing required file: $requiredEntry"
        }
    }
    if (-not ($entryNames | Where-Object { $_.Replace([char]92, '/').StartsWith('app/', [StringComparison]::OrdinalIgnoreCase) })) {
        throw "Release ZIP is missing app/ content."
    }
    $forbiddenPattern = '(^|/)\.runtime(/|$)|\.log$|(^|/)\.env$|(^|/)tests(/|$)|(^|/)openspec(/|$)'
    foreach ($entryName in $entryNames) {
        $normalizedEntryName = $entryName.Replace([char]92, '/')
        if ($normalizedEntryName -match $forbiddenPattern) {
            throw "Release ZIP contains forbidden content: $entryName"
        }
    }
}
finally {
    $archive.Dispose()
}

Write-Output "ChatExcel Launcher release package created: $zipPath"
Write-Output "SHA-256: $hash"
