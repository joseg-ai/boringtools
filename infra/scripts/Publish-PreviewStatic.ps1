# Native client contract: Azure/static-web-apps-cli 2.0.8; provenance in NOTICE.md.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Subscription,
    [Parameter(Mandatory)][string] $Tenant,
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][string] $AppName,
    [Parameter(Mandatory)][string] $ArtifactPath,
    [Parameter(Mandatory)][string] $ExpectedOrigin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$context = az account show --subscription $Subscription --query '{id:id,tenantId:tenantId}' --output json --only-show-errors | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $context.id -ne $Subscription -or $context.tenantId -ne $Tenant) {
    throw 'The selected Azure context does not match the approved subscription and tenant.'
}
$artifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
foreach ($file in @('index.html', '404.html', 'staticwebapp.config.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $artifact $file) -PathType Leaf)) { throw "Missing static artifact: $file" }
}
foreach ($entry in Get-ChildItem -LiteralPath $artifact -Recurse -Force) {
    if ($entry.Name -match '^(?:\.env(?:\..*)?|\.azure|\.squad|\.copilot|\.github|\.git|node_modules)$' -or
        ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Static upload contains private state, dependencies or linked files.'
    }
}
$hostname = az staticwebapp show --subscription $Subscription --resource-group $ResourceGroup --name $AppName --query defaultHostname --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or "https://$hostname" -cne $ExpectedOrigin) {
    throw 'The existing Static Web App does not match its approved generated origin.'
}

$previousToken = $env:SWA_CLI_DEPLOYMENT_TOKEN
$previousDebug = $env:SWA_CLI_DEBUG
$clientMetadataPath = Join-Path $env:USERPROFILE '.swa\deploy\StaticSitesClient.json'
if (-not (Test-Path -LiteralPath $clientMetadataPath)) { throw 'The official SWA deployment client must be installed by SWA CLI first.' }
$client = Get-Content -Raw -LiteralPath $clientMetadataPath | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $client.binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $client.metadata.files.'win-x64'.sha.ToLowerInvariant()) {
    throw 'The official deployment client checksum does not match its release metadata.'
}
$uploadRoot = Join-Path ([IO.Path]::GetTempPath()) ('domos-swa-upload-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $uploadRoot | Out-Null
Copy-Item -LiteralPath $artifact -Destination (Join-Path $uploadRoot 'artifact') -Recurse
$clientEnvironment = @{
    DEPLOYMENT_ACTION = 'upload'; DEPLOYMENT_PROVIDER = 'SwaCli'
    REPOSITORY_BASE = $uploadRoot; APP_LOCATION = 'artifact'; CONFIG_FILE_LOCATION = 'artifact'
    SKIP_APP_BUILD = 'true'; SKIP_API_BUILD = 'true'; VERBOSE = 'false'
    API_LOCATION = ''; DATA_API_LOCATION = ''; DEPLOYMENT_ENVIRONMENT = ''
    DEPLOYMENT_TOKEN = ''
}
$previousEnvironment = @{}
foreach ($name in $clientEnvironment.Keys) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }
Push-Location $uploadRoot
try {
    $token = az staticwebapp secrets list --subscription $Subscription --resource-group $ResourceGroup --name $AppName --query properties.apiKey --output tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) { throw 'SWA deployment token could not be resolved; no login will be attempted.' }
    $env:SWA_CLI_DEPLOYMENT_TOKEN = $token
    $env:SWA_CLI_DEBUG = 'log'
    $clientEnvironment.DEPLOYMENT_TOKEN = $token
    foreach ($name in $clientEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $clientEnvironment[$name]) }
    # SWA CLI 2.0.8 does not propagate native upload failures; invoke its checksum-verified client directly.
    $messages = & $client.binary run 2>&1
    $exitCode = $LASTEXITCODE
    $safeMessage = ($messages | Out-String).Replace($token, '[REDACTED]')
    if ($exitCode -ne 0) {
        throw "SWA upload failed with exit code ${exitCode}: $safeMessage"
    }
    $expected = Get-Content -Raw -LiteralPath (Join-Path $artifact 'index.html')
    $served = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        $response = Invoke-WebRequest -Uri "$ExpectedOrigin/" -TimeoutSec 30 -SkipHttpErrorCheck
        if ($response.StatusCode -eq 200 -and $response.Content -ceq $expected) { $served = $true; break }
        Start-Sleep -Seconds 5
    }
    if (-not $served) { throw "SWA CLI did not publish the expected index (its exit code alone is insufficient): $safeMessage" }
} finally {
    $env:SWA_CLI_DEPLOYMENT_TOKEN = $previousToken
    $env:SWA_CLI_DEBUG = $previousDebug
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name]) }
    $clientEnvironment.DEPLOYMENT_TOKEN = ''
    $token = $null
    Pop-Location
    Remove-Item -LiteralPath $uploadRoot -Recurse -Force
}
Write-Output "Expected static index is live at $ExpectedOrigin; browser acceptance is still required."
