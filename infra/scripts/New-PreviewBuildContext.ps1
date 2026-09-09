[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Destination,
    [Parameter(Mandatory)][string] $ManifestPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Build context destination must be a new directory.' }
if ((Get-Content -Raw -LiteralPath (Join-Path $root '.npmrc')) -match '(?i)(_auth|password|token|registry\s*=)') {
    throw 'Review npm registry configuration before uploading a build context.'
}
$files = @('package.json', 'package-lock.json', '.npmrc')
foreach ($workspace in @('packages\catalog', 'packages\contracts', 'packages\tool-core', 'apps\site', 'apps\workspace', 'apps\diagnostics')) {
    $files += "$workspace\package.json"
}
foreach ($directory in @('packages\catalog\src', 'packages\contracts\src', 'apps\diagnostics\src')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $directory) -File -Recurse -Filter '*.ts') {
        if ($file.Name -match '\.test(?:-support)?\.ts$') { continue }
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Do not upload linked source files.' }
        $files += [IO.Path]::GetRelativePath($root, $file.FullName)
    }
}
$files += @('apps\diagnostics\scripts\build.mjs', 'apps\diagnostics\scripts\container-smoke.mjs')
$mapping = @($files | Sort-Object -Unique | ForEach-Object { @{ source = $_; destination = $_ } })
$mapping += @{ source = 'infra\containers\diagnostics.Dockerfile'; destination = 'Dockerfile' }
$manifest = foreach ($entry in $mapping) {
    $source = Join-Path $root $entry.source
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing required build source: $($entry.source)" }
    $target = Join-Path $destinationPath $entry.destination
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
    [ordered]@{ path = $entry.destination.Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$serialized = $manifest | ConvertTo-Json -Depth 5 -Compress
$snapshotHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($serialized))).ToLowerInvariant()
[ordered]@{ algorithm = 'SHA256'; snapshot = $snapshotHash; files = $manifest } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
Write-Output "Prepared $($manifest.Count) allowlisted files; snapshot $snapshotHash."
