[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $ApiOrigin,
    [string] $ArtifactRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ApiOrigin -cnotmatch '^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$') {
    throw 'A production build requires an exact HTTPS API origin, with no path or trailing slash.'
}
function Get-HtmlAttributes([string] $Text) {
    $attributes = @{}
    $pattern = '(?<name>[^\s=/>]+)(?:\s*=\s*(?:"(?<value>[^"]*)"|''(?<value>[^'']*)''|(?<value>[^\s>]+)))?'
    foreach ($match in [regex]::Matches($Text, $pattern)) {
        $name = $match.Groups['name'].Value
        if ($attributes.ContainsKey($name)) { throw "Duplicate HTML attribute: $name." }
        $attributes[$name] = [Net.WebUtility]::HtmlDecode($match.Groups['value'].Value)
    }
    return $attributes
}

function Get-ScriptHashes([string] $Content) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Content)
    foreach ($algorithm in @('SHA256', 'SHA384', 'SHA512')) {
        $hasher = switch ($algorithm) {
            SHA256 { [Security.Cryptography.SHA256]::Create() }
            SHA384 { [Security.Cryptography.SHA384]::Create() }
            SHA512 { [Security.Cryptography.SHA512]::Create() }
        }
        try { "'$($algorithm.ToLowerInvariant())-$([Convert]::ToBase64String($hasher.ComputeHash($bytes)))'" }
        finally { $hasher.Dispose() }
    }
}

function ConvertTo-Headers($Headers) {
    if ($Headers -isnot [System.Collections.IDictionary]) { throw 'Headers must be an object.' }
    $result = @{}
    foreach ($key in $Headers.Keys) {
        if ($key -cnotmatch '^[A-Za-z0-9-]+$' -or $result.ContainsKey($key) -or
            $Headers[$key] -isnot [string] -or $Headers[$key] -match '[\r\n]') {
            throw 'Invalid or ambiguous header definition.'
        }
        $result[$key] = $Headers[$key]
    }
    return $result
}

function Assert-Policy(
    $Policy, [string] $Connection, $AllowedHashes, $Scripts = @(),
    [switch] $Meta, [switch] $Asset
) {
    if ($Policy -isnot [string] -or [string]::IsNullOrWhiteSpace($Policy)) { throw 'Missing Content-Security-Policy.' }
    $directives = @{}
    foreach ($part in $Policy.Split(';')) {
        $tokens = @($part.Trim() -split '\s+' | Where-Object { $_ })
        if ($tokens.Count -eq 0) { continue }
        $name = $tokens[0].ToLowerInvariant()
        if ($directives.ContainsKey($name) -or $tokens.Count -lt 2) { throw 'Duplicate or empty CSP directive.' }
        $directives[$name] = @($tokens | Select-Object -Skip 1)
        if (@($directives[$name] | Select-Object -Unique).Count -ne $directives[$name].Count) { throw 'Duplicate CSP source.' }
    }
    $sources = @{
        'default-src' = @("'none'"); 'script-src' = @("'self'")
        'style-src' = @("'self'", "'unsafe-inline'"); 'img-src' = @("'self'", 'data:')
        'font-src' = @("'self'"); 'connect-src' = @($Connection); 'worker-src' = @("'self'")
        'child-src' = @("'none'"); 'frame-src' = @("'none'"); 'object-src' = @("'none'")
        'base-uri' = @("'none'"); 'form-action' = @("'none'"); 'frame-ancestors' = @("'none'")
    }
    $required = if ($Asset) {
        @('default-src', 'script-src', 'connect-src', 'object-src', 'base-uri')
    } else { @($sources.Keys | Where-Object { -not $Meta -or $_ -ne 'frame-ancestors' }) }
    foreach ($name in $required) {
        if (-not $directives.ContainsKey($name)) { throw "CSP must explicitly define $name." }
    }
    foreach ($name in $directives.Keys) {
        if (-not $sources.ContainsKey($name)) { throw "Unsupported CSP directive: $name." }
        foreach ($source in $directives[$name]) {
            if ($source -cin $sources[$name]) { continue }
            if ($name -eq 'script-src' -and $AllowedHashes.Contains($source)) { continue }
            throw "CSP $name permits an unsafe source or an unknown inline script hash: $source."
        }
        foreach ($source in $sources[$name]) {
            if ($source -cnotin $directives[$name]) { throw "CSP $name is missing required source $source." }
        }
    }
    foreach ($script in $Scripts) {
        if (-not @($script.Hashes | Where-Object { $_ -cin $directives['script-src'] }).Count) {
            throw 'CSP does not permit the actual inline hydration script.'
        }
    }
}

function Test-RouteMatch([string] $Pattern, [string] $Path) {
    if ($Pattern.EndsWith('*')) { return $Path.StartsWith($Pattern.TrimEnd('*'), [StringComparison]::Ordinal) }
    return $Pattern -ceq $Path
}

function Get-EffectiveHeaders($Config, [string] $Path) {
    $headers = ConvertTo-Headers $Config.globalHeaders
    # SWA stops at the first matching rule, even when it has no CSP header.
    foreach ($rule in $Config.routes) {
        if (-not (Test-RouteMatch $rule.route $Path)) { continue }
        if ($rule.Contains('redirect')) { return Get-EffectiveHeaders $Config $rule.redirect }
        if ($rule.Contains('headers')) {
            foreach ($entry in (ConvertTo-Headers $rule.headers).GetEnumerator()) {
                if ($entry.Value -ceq '') { $headers.Remove($entry.Key) }
                else { $headers[$entry.Key] = $entry.Value }
            }
        }
        break
    }
    return $headers
}

$livePages = 0
foreach ($app in @('site', 'workspace')) {
    $dist = Join-Path $ArtifactRoot "apps\$app\dist"
    foreach ($file in @('index.html', '404.html', 'staticwebapp.config.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $dist $file) -PathType Leaf)) {
            throw "Missing $app build artifact: $file. Do not upload a scaffold or omit its security configuration."
        }
    }
    $config = Get-Content -Raw -LiteralPath (Join-Path $dist 'staticwebapp.config.json') | ConvertFrom-Json -AsHashtable
    foreach ($key in $config.Keys) {
        if ($key -cnotin @('globalHeaders', 'routes', 'mimeTypes', 'responseOverrides')) {
            throw "Unsupported SWA configuration: $key."
        }
    }
    if (-not $config.Contains('globalHeaders') -or -not $config.Contains('routes') -or $config.routes -isnot [array]) {
        throw "$app is missing global headers or its routes array."
    }
    if (-not $config.Contains('responseOverrides') -or $config.responseOverrides.Count -ne 1 -or
        -not $config.responseOverrides.Contains('404') -or $config.responseOverrides['404'].Count -ne 2 -or
        $config.responseOverrides['404']['rewrite'] -cne '/404.html' -or $config.responseOverrides['404']['statusCode'] -ne 404) {
        throw 'Expected the static /404.html response override; other rewrites are not supported.'
    }
    $paths = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $appHashes = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($page in (Get-ChildItem -LiteralPath $dist -Recurse -File -Filter '*.html')) {
        $html = Get-Content -Raw -LiteralPath $page.FullName
        $fileRoute = '/' + [IO.Path]::GetRelativePath($dist, $page.FullName).Replace('\', '/')
        $metadata = @{}
        foreach ($tag in [regex]::Matches($html, '(?is)<meta\b([^>]*)>')) {
            $attributes = Get-HtmlAttributes $tag.Groups[1].Value
            $name = if ($attributes.ContainsKey('http-equiv')) { $attributes['http-equiv'] } else { $attributes['name'] }
            if ($name -in @('domos-processing-mode', 'domos-api-origin', 'Content-Security-Policy')) {
                if ($metadata.ContainsKey($name) -or -not $attributes.ContainsKey('content')) { throw 'Missing or ambiguous page metadata.' }
                $metadata[$name] = $attributes['content']
            }
        }
        $mode = $metadata['domos-processing-mode']
        if (($app -eq 'workspace' -and $mode -cnotin @('local', 'live')) -or
            ($app -eq 'site' -and $null -ne $mode -and $mode -cne 'local')) {
            throw "Invalid processing mode for $app$fileRoute."
        }
        $live = $mode -ceq 'live'
        if ($live) {
            $livePages++
            if ($metadata['domos-api-origin'] -cne $ApiOrigin) {
                throw 'Live page was compiled for a different API origin.'
            }
        } elseif ($metadata.ContainsKey('domos-api-origin')) { throw 'Local documents must not declare an API origin.' }
        $scripts = @()
        $pageHashes = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($script in [regex]::Matches($html, '(?is)<script\b([^>]*)>(.*?)</script\s*>')) {
            $attributes = Get-HtmlAttributes $script.Groups[1].Value
            if ($attributes.ContainsKey('src')) {
                $src = $attributes['src']
                if ($src -cnotmatch '^/(?!/)[A-Za-z0-9_./-]+$' -or $src.Contains('..') -or
                    -not (Test-Path -LiteralPath (Join-Path $dist $src.TrimStart('/')) -PathType Leaf)) {
                    throw "External or missing script in $app$fileRoute."
                }
            } elseif ($script.Groups[2].Value.Length -gt 0) {
                $hashes = @(Get-ScriptHashes $script.Groups[2].Value)
                $scripts += @{ Hashes = $hashes }
                foreach ($hash in $hashes) { [void] $pageHashes.Add($hash); [void] $appHashes.Add($hash) }
            }
        }
        $connection = if ($live) { $ApiOrigin } else { "'none'" }
        Assert-Policy $metadata['Content-Security-Policy'] $connection $pageHashes $scripts -Meta
        $canonical = if ($fileRoute.EndsWith('/index.html')) { $fileRoute.Substring(0, $fileRoute.Length - 10) } else { $fileRoute.Substring(0, $fileRoute.Length - 5) }
        $aliases = @($fileRoute, $canonical)
        if ($canonical -ne '/') { $aliases += @($canonical.TrimEnd('/'), ($canonical.TrimEnd('/') + '/')) }
        $document = @{ FileRoute = $fileRoute; Canonical = $canonical; Connection = $connection; Scripts = $scripts }
        foreach ($path in @($aliases | Select-Object -Unique)) {
            if ($paths.ContainsKey($path)) { throw "Ambiguous static document path: $path." }
            $paths.Add($path, $document)
        }
    }
    $globals = ConvertTo-Headers $config.globalHeaders
    # Global hashes may cover this app's layouts, never the other app's scripts.
    Assert-Policy $globals['Content-Security-Policy'] "'none'" $appHashes
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($rule in $config.routes) {
        if ($rule -isnot [System.Collections.IDictionary] -or -not $rule.Contains('route') -or
            $rule.route -isnot [string] -or $rule.route -cnotmatch '^/(?:[A-Za-z0-9_-]+/)*(?:[A-Za-z0-9_.-]+|\*)?$' -or
            -not $seen.Add($rule.route)) { throw 'Invalid, duplicate or unsupported SWA route pattern.' }
        foreach ($key in $rule.Keys) {
            if ($key -cnotin @('route', 'headers', 'redirect', 'statusCode')) { throw "Unsupported SWA route behavior: $key." }
        }
        $matched = @($paths.Keys | Where-Object { Test-RouteMatch $rule.route $_ })
        if ($rule.route -ceq '/_astro/*') {
            if ($matched.Count -gt 0) { throw 'HTML must not be served under the static asset route.' }
            if (-not (Test-Path -LiteralPath (Join-Path $dist '_astro') -PathType Container)) { throw 'Missing static asset directory.' }
        } elseif ($matched.Count -eq 0) { throw "Unknown SWA document route: $($rule.route)." }
        if ($rule.Contains('headers')) { $null = ConvertTo-Headers $rule.headers }
        if ($rule.Contains('redirect')) {
            if ($rule.route.EndsWith('*') -or $rule.Contains('headers') -or -not $rule.Contains('statusCode') -or
                $rule.statusCode -notin @(301, 302) -or $rule.redirect -isnot [string] -or
                -not $paths.ContainsKey($rule.redirect) -or $rule.redirect -ceq $rule.route -or
                $paths[$rule.route].FileRoute -cne $paths[$rule.redirect].FileRoute -or
                $rule.redirect -cne $paths[$rule.route].Canonical) { throw 'Unsupported or ambiguous static redirect.' }
        } elseif ($rule.Contains('statusCode')) { throw 'Unexpected document status override.' }
    }
    # Redirects must terminate at their canonical document, not recurse or shadow it.
    foreach ($rule in $config.routes) {
        if (-not $rule.Contains('redirect')) { continue }
        foreach ($target in $config.routes) {
            if (-not (Test-RouteMatch $target.route $rule.redirect)) { continue }
            if ($target.Contains('redirect')) { throw 'Canonical document route redirects again.' }
            break
        }
    }
    foreach ($path in $paths.Keys) {
        $document = $paths[$path]
        $headers = Get-EffectiveHeaders $config $path
        Assert-Policy $headers['Content-Security-Policy'] $document.Connection $appHashes $document.Scripts
    }
    $assetDirectory = Join-Path $dist '_astro'
    if (Test-Path -LiteralPath $assetDirectory -PathType Container) {
        foreach ($asset in (Get-ChildItem -LiteralPath $assetDirectory -Recurse -File)) {
            $path = '/' + [IO.Path]::GetRelativePath($dist, $asset.FullName).Replace('\', '/')
            $headers = Get-EffectiveHeaders $config $path
            Assert-Policy $headers['Content-Security-Policy'] "'none'" $appHashes -Asset
        }
    }
}
if ($livePages -ne 3) { throw 'Expected exactly three real live-tool workspace pages.' }
Write-Output 'Both static artifacts enforce effective SWA headers and hydration CSP matching their local/live processing boundaries.'
