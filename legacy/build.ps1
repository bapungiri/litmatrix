$ErrorActionPreference = 'Stop'

# Read version from manifest
$manifest = Get-Content -Raw -Path "manifest.json" | ConvertFrom-Json
$version = $manifest.version

# Prepare output path
$dist = Join-Path $PSScriptRoot "dist"
if (Test-Path $dist) {
    Remove-Item $dist -Recurse -Force
}
New-Item -ItemType Directory -Path $dist | Out-Null

$destination = Join-Path $dist "zotero-annotable-$version.xpi"

# Build XPI (zip of root files)
Compress-Archive -Path @("manifest.json", "background.js", "content") -DestinationPath $destination -Force

Write-Host "Built" $destination
