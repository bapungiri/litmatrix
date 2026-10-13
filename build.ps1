# Packs plugin/ into dist/litmatrix-<version>.xpi (a zip with forward-slash paths).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$src = Join-Path $PSScriptRoot 'plugin'
$version = (Get-Content -Raw (Join-Path $src 'manifest.json') | ConvertFrom-Json).version
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$xpi = Join-Path $dist "litmatrix-$version.xpi"
if (Test-Path $xpi) { Remove-Item $xpi }

$zip = [System.IO.Compression.ZipFile]::Open($xpi, 'Create')
try {
    Get-ChildItem $src -Recurse -File | ForEach-Object {
        $entry = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry)
    }
}
finally {
    $zip.Dispose()
}
Write-Host "Built $xpi"
