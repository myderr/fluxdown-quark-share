$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$pluginName = (($manifest.identity -split '@', 2)[1]).ToLowerInvariant()
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($pluginName) -or [string]::IsNullOrWhiteSpace($version)) {
    throw 'manifest identity/version is required for versioned packaging'
}

$entryPaths = @()
foreach ($resolver in @($manifest.resolvers)) {
    if ($resolver -and $resolver.entry) { $entryPaths += [string]$resolver.entry }
}
if ($manifest.hooks -and $manifest.hooks.entry) { $entryPaths += [string]$manifest.hooks.entry }
if ($manifest.auth -and $manifest.auth.entry) { $entryPaths += [string]$manifest.auth.entry }
if ($manifest.main -and $manifest.main.entry) { $entryPaths += [string]$manifest.main.entry }
foreach ($view in @($manifest.contributes.views)) {
    if ($view -and $view.icon) { $entryPaths += [string]$view.icon }
}
foreach ($pageScript in @($manifest.contributes.pageScripts)) {
    if ($pageScript) { $entryPaths += @($pageScript.js) }
}
$entryPaths = $entryPaths | Sort-Object -Unique

$archive = Join-Path $dist "$pluginName-$version.fxplug"
$zipArchive = Join-Path $dist "$pluginName-$version.zip"
$tempRoot = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).ProviderPath.TrimEnd([char[]] '\/')
$staging = Join-Path $tempRoot ('quark-share-package-' + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $dist -Force | Out-Null
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    Copy-Item -LiteralPath $manifestPath -Destination $staging
    foreach ($relativePath in $entryPaths) {
        $source = Join-Path $root $relativePath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "manifest entry file is missing: $relativePath"
        }
        $destination = Join-Path $staging $relativePath
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $source -Destination $destination
    }
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    if (Test-Path -LiteralPath $zipArchive) { Remove-Item -LiteralPath $zipArchive -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipArchive -CompressionLevel Optimal
    Move-Item -LiteralPath $zipArchive -Destination $archive
    $genericArchive = Join-Path $dist "$pluginName.fxplug"
    if (Test-Path -LiteralPath $genericArchive) { Remove-Item -LiteralPath $genericArchive -Force }
    Copy-Item -LiteralPath $archive -Destination $genericArchive
    Write-Output "Created $archive"
    Write-Output "Updated $genericArchive"
}
finally {
    if (Test-Path -LiteralPath $staging) {
        $resolvedStaging = (Resolve-Path -LiteralPath $staging).ProviderPath
        if ((Split-Path -Parent $resolvedStaging) -ne $tempRoot -or (Get-Item -LiteralPath $resolvedStaging).Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
            throw 'refusing to remove staging outside the temporary directory'
        }
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
}
