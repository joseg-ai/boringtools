[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][ValidateSet('bootstrap', 'main')][string] $Phase,
    [switch] $Development
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$document = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
if (-not $document.ContainsKey('parameters')) { throw 'Expected an ARM parameters document.' }
$parameters = $document.parameters

function Get-Value([string] $Name, $Default = $null) {
    if (-not $parameters.ContainsKey($Name)) {
        if ($null -ne $Default) { return ,$Default }
        throw "Missing required parameter: $Name"
    }
    $entry = $parameters[$Name]
    if ($entry -isnot [System.Collections.IDictionary] -or -not $entry.Contains('value')) {
        throw "Parameter $Name must contain a literal value, not an environment substitution or secret reference."
    }
    return ,$entry.value
}

function Assert-Text([string] $Name, [string] $Pattern, [int] $Maximum) {
    $value = Get-Value $Name
    if ($value -isnot [string] -or $value.Length -gt $Maximum -or $value -cnotmatch $Pattern) {
        throw "Invalid or unselected $Name."
    }
}

Assert-Text 'location' '^[a-z][a-z0-9]+$' 64
Assert-Text 'registryName' '^[a-z0-9]{5,50}$' 50
Assert-Text 'pullIdentityName' '^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$' 128
if ($Phase -eq 'bootstrap') {
    $allowed = @('location', 'registryName', 'pullIdentityName')
} else {
    $allowed = @(
        'location', 'staticAppsLocation', 'registryName', 'pullIdentityName',
        'environmentName', 'apiAppName', 'siteAppName', 'workspaceAppName',
        'staticAppsSku', 'imageRepository', 'imageDigest', 'corsOrigins', 'publicApiOrigin', 'useGeneratedOrigins',
        'minReplicas', 'maxReplicas', 'cpuCores', 'httpConcurrency', 'apiCertificateId'
    )
    Assert-Text 'staticAppsLocation' '^[a-z][a-z0-9]+$' 64
    foreach ($name in @('environmentName', 'apiAppName')) {
        Assert-Text $name '^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$' 32
    }
    foreach ($name in @('siteAppName', 'workspaceAppName')) {
        Assert-Text $name '^[a-zA-Z0-9][a-zA-Z0-9-]+$' 40
    }
    if ((Get-Value 'siteAppName') -eq (Get-Value 'workspaceAppName')) {
        throw 'The public site and ad-free workspace must be different Static Web Apps.'
    }
    $repository = Get-Value 'imageRepository' 'diagnostics'
    if ($repository -isnot [string] -or $repository -cnotmatch '^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$') {
        throw 'imageRepository must be an untagged repository name without a registry hostname.'
    }
    Assert-Text 'imageDigest' '^sha256:[0-9a-f]{64}$' 71
    if ((Get-Value 'imageDigest') -eq ('sha256:' + ('0' * 64))) {
        throw 'A zero digest is not a release image.'
    }
    $sku = Get-Value 'staticAppsSku' 'Standard'
    if ($sku -cnotin @('Standard', 'Free')) { throw 'Unsupported SWA SKU.' }
    if ($sku -eq 'Free' -and -not $Development) { throw 'Free has no SLA; pass -Development explicitly for nonproduction only.' }
    $origins = Get-Value 'corsOrigins' @('https://tools.domosdigial.com')
    if ($origins -isnot [array] -or $origins.Count -lt 1 -or $origins.Count -gt 4) {
        throw 'corsOrigins must contain one to four exact HTTPS origins.'
    }
    foreach ($origin in $origins) {
        if ($origin -isnot [string] -or $origin -cnotmatch '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$') {
            throw 'Each CORS origin must be canonical HTTPS, without wildcard, credentials, path or trailing slash.'
        }
        $uri = [uri]$origin
        if ($uri.Authority -ne $origin.Substring(8) -or $uri.HostNameType -ne 'Dns') {
            throw 'Each CORS origin must use a canonical DNS hostname.'
        }
    }
    if (@($origins | Select-Object -Unique).Count -ne $origins.Count) { throw 'Duplicate CORS origins.' }
    $apiOrigin = Get-Value 'publicApiOrigin' 'https://api.domosdigial.com'
    if ($apiOrigin -isnot [string] -or $apiOrigin -cnotmatch '^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$') {
        throw 'publicApiOrigin must be an exact HTTPS API hostname, without path or trailing slash.'
    }
    foreach ($name in @('minReplicas', 'maxReplicas', 'httpConcurrency')) {
        $defaults = @{ minReplicas = 0; maxReplicas = 3; httpConcurrency = 4 }
        $value = Get-Value $name $defaults[$name]
        if ($value -isnot [long] -and $value -isnot [int]) { throw "$name must be an integer." }
    }
    if ((Get-Value 'minReplicas' 0) -notin @(0, 1)) { throw 'minReplicas must be 0 or 1.' }
    if ((Get-Value 'maxReplicas' 3) -lt 1 -or (Get-Value 'maxReplicas' 3) -gt 10) { throw 'maxReplicas must be 1-10.' }
    if ((Get-Value 'httpConcurrency' 4) -lt 1 -or (Get-Value 'httpConcurrency' 4) -gt 15) { throw 'httpConcurrency must be 1-15, below the per-replica 16-request cap.' }
    if ((Get-Value 'cpuCores' '0.25') -cnotin @('0.25', '0.5', '1.0')) { throw 'Unsupported CPU/memory pair.' }
    $certificateId = Get-Value 'apiCertificateId' ''
    $generatedOrigins = Get-Value 'useGeneratedOrigins' $false
    if ($generatedOrigins -isnot [bool]) { throw 'useGeneratedOrigins must be a boolean.' }
    if ($generatedOrigins -and $certificateId -ne '') { throw 'Generated-origin previews must not bind custom certificates.' }
    if ($certificateId -ne '' -and $certificateId -notmatch '^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft\.App/managedEnvironments/[^/]+/(managedCertificates|certificates)/[^/]+$') {
        throw 'apiCertificateId must be an existing ACA environment certificate resource ID.'
    }
}

foreach ($name in $parameters.Keys) {
    if ($name -cnotin $allowed) { throw "Unknown parameter: $name" }
}
Write-Output "Local $Phase parameter validation passed; Azure context, image existence and deployment authorization are NOT established."
