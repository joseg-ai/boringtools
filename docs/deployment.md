# Deployment preparation: Static Web Apps + Container Apps Consumption

**This runbook does not itself authorize deployment, DNS changes, certificate
issuance or ad activation.** The active preview authorization and phase-specific
validation proof are recorded in `.azure\deployment-plan.md`.
The architecture replaces earlier AKS research. `.azure\deployment-plan.md`
remains the coordinator's approval record; this platform work does not mark the
whole application ready for validation.

## Authorized generated-hostname preview

The 2026-09-08 preview uses subscription
`40907613-5278-48a4-ab10-c9944be31c8b`, tenant
`3d374b94-78d6-435f-b7a6-b8337c1282b6`, region `eastus2`, and new resource group
`rg-domos-preview-eus2-40907613`. It does not bind any custom domain or enable ads.
Every CLI operation must select this subscription and verify its tenant; never
use `az account set` or an implicit default.

For a missing RG, validate/preview `infra\preview-bootstrap.bicep` at subscription
scope, then apply that exact stage. This creates only the RG, ACR Basic and the
pull identity/AcrPull assignment. It does not require a placeholder image or
count a nonexistent-group validation as successful.

The operator prohibited commits/pushes. The authorized alternative to the Git
publication instructions below is `infra\scripts\New-PreviewBuildContext.ps1`:
copy its 29 allowlisted files into a new external staging directory, retain the
SHA-256 manifest under `.azure`, then run the ACR quick build **from that staging
directory** with `--file .\Dockerfile`, an explicit registry/subscription,
`--platform linux/amd64` and the snapshot-tagged image. Do not upload the repo
root. This excludes `.azure`, `.env`, `.squad`, `.copilot`, `.github`, dependencies,
browser captures, tests and frontend source. ACR Tasks execution is billable.

The final Docker build exercises actual Node 24 non-root health and graceful
shutdown. Scan the exact manifest digest independently. The initial Debian 12
image was not promoted after findings in its unused package-manager tooling.
The runtime now uses digest-pinned Distroless Node 24/Debian 13, omitting shells,
package managers and unused OS utilities rather than suppressing their findings.
The transient Trivy scanner and its database are not shipped with the app.

Main uses `useGeneratedOrigins=true`: CORS comes from the exact workspace SWA
hostname; API self-origin comes from the app name and environment default domain;
site/workspace hosts are included in the diagnostic target denylist. Empty
`apiCertificateId` is mandatory. Run the full validation/what-if workflow again
with the real image digest before applying main.

Read `siteDefaultOrigin`, `workspaceDefaultOrigin` and `apiDefaultOrigin` from
the named main deployment. Set **all three** process-level build variables:
`PUBLIC_SITE_ORIGIN`, `PUBLIC_WORKSPACE_ORIGIN`, `PUBLIC_API_ORIGIN`. Build each
frontend, then run `Test-StaticArtifacts.ps1 -ApiOrigin $env:PUBLIC_API_ORIGIN`.
Navigation, guides, canonical/OG URLs and sitemap now consume the selected
origins; changing SWA runtime settings cannot rewrite old static bundles.

Local SWA CLI 2.0.8 can upload each dist without GitHub or new Entra federation.
Resolve each existing resource's token with scoped `az staticwebapp secrets list`
into memory only; set `SWA_CLI_DEPLOYMENT_TOKEN` transiently, disable keychain
use, and use `--env production` (the resources are previews, but their staging
slots are disabled). Set app/output/config locations to that app's dist, leave
API location empty, never print tokens or use debug/silly logging, and clear the
token in `finally`. No login is needed when a valid deployment token is supplied.
The existing GitHub workflow below is optional and was not dispatched.

Actual SWA upload exposed two issues: redirect rules accept only 301/302, so
the generator now emits 301 and the artifact validator rejects 307/308; and
SWA CLI 2.0.8 does not propagate its native client's failure exit status.
`Publish-PreviewStatic.ps1` therefore invokes the CLI-downloaded, checksum-verified
official client directly with transient environment credentials, captures its
exit status, and requires the served homepage to equal the built index.
It uses the same upload/build-skip contract, not a custom upload API.

## Resource and application boundaries

| Resource | Baseline | Purpose |
|---|---|---|
| Public Static Web App | Standard | `apps\site\dist` at `https://domosdigial.com`; directory, guides, ads disabled |
| Workspace Static Web App | Standard, separate resource | `apps\workspace\dist` at `https://tools.domosdigial.com`; no ads, analytics or third-party scripts/fonts |
| Container Apps environment | Workload-profiles environment containing **only** the `Consumption` profile | API hosting without Dedicated profile capacity |
| Diagnostic Container App | Linux amd64, 0.25 vCPU / 0.5 GiB, min 0 / max 3 replicas | External HTTPS ingress forwards to Fastify port 8787; `https://api.domosdigial.com` after approved domain binding |
| Container Registry | Basic, authenticated public endpoint | Private image storage; no admin login or anonymous pull |
| User-assigned identity | Registry-scoped AcrPull | Image pull only; `lifecycle: None` denies the application access to its identity endpoint |

Standard is the production baseline for both static apps. `staticAppsSku=Free`
is a deliberate development option **without an SLA** and requires
`Test-Parameters.ps1 -Development`. An individual Azure service SLA does not
establish an end-to-end availability promise for this application.

There is no AKS cluster, Dedicated workload profile, private endpoint, VNet/NAT,
Front Door/WAF, Redis, database, storage account or separately provisioned load
balancer. Do not add those to solve a bootstrap problem. Managed ingress is
provided by ACA, not a separately selected load-balancer SKU.

SWA Standard and ACR Basic have standing charges. ACA compute, requests,
network transfer, image storage/transfer and any later logging may cost money;
scale-to-zero does not make the entire system free. Free grants are subject to
current Azure pricing and shared subscription consumption, not guaranteed here.
Keep this environment free of Dedicated profiles/private endpoints to avoid
their associated management/networking fees. Current price, quota, regional
availability and tenant policy review remain cloud gates, not completed checks.

## Artifacts and bootstrap dependency

| File | Contract |
|---|---|
| `infra\registry-bootstrap.bicep` | Creates only ACR, a user-assigned identity and registry-scoped AcrPull |
| `infra\main.bicep` | References that registry/identity; requires an existing real image digest before creating either frontend or the API |
| `infra\*.parameters.example.json` | Empty required selections intentionally fail preflight; no fabricated Azure context |
| `infra\scripts\Test-Parameters.ps1` | Offline naming, exact HTTPS CORS, SKU, digest and bounded capacity checks |
| `infra\scripts\Test-StaticArtifacts.ps1` | Requires both static outputs and workspace CSP compatible with the configured API origin |
| `infra\containers\diagnostics.Dockerfile` | Multi-stage, Node 24 LTS, non-root, separately installed audited production dependencies |
| `infra\containers\diagnostics.Dockerfile.dockerignore` | Allowlisted build context; no local env files, inputs, Git/Squad data or tests |
| `.github\workflows\ci.yml` | Push/PR check, test, build, static boundaries, offline Bicep compilation and local container smoke; no Azure login or push |
| `.github\workflows\deploy-manual.yml` | Protected manual release of an already-published digest to **existing** resources |

The required order is **registry/identity -> build and publish the real API
image -> confirm its digest and pull permissions -> main infrastructure ->
separate static uploads**. There is no Hello World image, implicit `latest`,
auto-generated initial API or hidden azd registry step.

Both templates target an explicitly selected **existing resource group**.
Bootstrap and main use the same registry name, identity name and resource group.
The registry is expected to use its default **RBAC Registry Permissions**
mode, not ABAC Repository Permissions; AcrPull does not grant access in ABAC
mode. Review this explicitly if reusing an existing registry. ARM-audience
authentication is enabled for managed-identity image pulls.

## Local preparation (Windows PowerShell 7)

Run from the repository root with installed Node 24 LTS, npm 11, PowerShell 7,
Bicep and a Linux Docker daemon. Local Node 25.9 may execute the code, but CI and
the runtime deliberately target Node 24. Do not install or upgrade tools merely
because a version differs; investigate an actual missing-dependency failure.
Forward slashes inside Dockerfiles and Ubuntu action inputs are required by
those Linux runtimes; these local commands use Windows paths.

```powershell
$ErrorActionPreference = 'Stop'
$env:ASTRO_TELEMETRY_DISABLED = '1'
$env:PUBLIC_API_ORIGIN = 'https://api.domosdigial.com'
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Application check failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Application tests failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
.\infra\scripts\Test-StaticArtifacts.ps1 -ApiOrigin $env:PUBLIC_API_ORIGIN
bicep build .\infra\registry-bootstrap.bicep --stdout | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap Bicep failed.' }
bicep build .\infra\main.bicep --stdout | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Main Bicep failed.' }
npm audit --omit=dev --workspace=@domos/diagnostics --include-workspace-root=false --audit-level=high
if ($LASTEXITCODE -ne 0) { throw 'Resolve production dependency advisories before release.' }
```

Bicep compilation runs its configured linter and does not authenticate or query
the subscription. It does not prove resource availability, RBAC, policy
compliance, image existence, DNS or runtime behavior.

The container build invokes the actual `@domos/diagnostics` build script. Its
esbuild contract emits `apps\diagnostics\dist\server.mjs`, bundles internal
`@domos/contracts`/`@domos/catalog` TypeScript and externalizes third-party npm
dependencies. The final image includes the resulting `dist` directory (including
linked legal notices), production `node_modules`, and any API-local dependency
directory. No runtime TypeScript workspace symlinks are needed. If the app build
adds output files or changes its entry point, coordinate the Dockerfile rather
than copying all development packages into production.

```powershell
docker version
if ($LASTEXITCODE -ne 0) { throw 'Start the separately approved local Linux Docker daemon; no image has been built.' }
docker build --platform linux/amd64 --file .\infra\containers\diagnostics.Dockerfile --tag domos-diagnostics:local .
if ($LASTEXITCODE -ne 0) { throw 'Image build failed.' }
# Foreground, localhost-only, read-only filesystem and all capabilities dropped.
# Stop from another terminal with: docker stop --time 30 domos-diagnostics-local
docker run --rm --name domos-diagnostics-local --read-only --cap-drop=ALL --security-opt=no-new-privileges --memory=512m --cpus=0.25 --publish 127.0.0.1:8787:8787 --env CORS_ORIGINS=http://localhost:4322 --env NODE_ENV=development domos-diagnostics:local
```

In another terminal, use `Invoke-RestMethod http://localhost:8787/healthz` and
`docker stats --no-stream domos-diagnostics-local`. Health must be HTTP 200 with
`service=domos-diagnostics`, `status=ok`, not a scaffold's 503 `not-ready`.
Exercise concurrent controlled diagnostic targets and shutdown as well as idle
health. Do not log the targets or HTTP headers. The CI smoke test enforces
non-root/read-only/capability-dropped startup and clean SIGTERM exit at the
smallest CPU/memory size, but **it is not a peak-load sizing benchmark**.

The base image is digest-pinned and can be refreshed explicitly with
`docker buildx imagetools inspect node:24-trixie-slim`. Update the Dockerfile
digest and NOTICE together after reviewing the upstream image. Never override
`NODE_IMAGE` with a mutable base for a production release. Image builds run the
production npm audit and fail on high/critical findings or audit errors;
low/moderate advisories still require release review. The final runtime uses a
separately pinned Distroless Node 24 image with no shell/npm/Corepack/Yarn;
builds retain npm in their separate dependency stages. Refresh both image
digests deliberately. OS image scanning remains
a separate release gate; an npm audit says nothing about Debian packages.

**Preparation-machine limitation:** the Docker CLI is installed but its Linux
engine pipe was unavailable. No container image build or constrained-container
memory measurement has been completed here. CPU/memory defaults are provisional
until the finished API passes the checks above.

## Capacity, safety and logging

`cpuCores` accepts `0.25`, `0.5` or `1.0` and chooses the supported memory pair
automatically. `minReplicas` is 0 (cold starts permitted) or 1 (warm-instance
cost); `maxReplicas` defaults to 3 and is bounded to 1-10.
`httpConcurrency=4` is an HTTP autoscaling **target**, not a hard in-flight
limit, per-client limit, request queue size or instantaneous response to a burst.
The scaler samples concurrency, and scale-out is not immediate. A 30-second
polling interval and 300-second cooldown are configured; HTTP activation has
platform-specific behavior rather than a strict timing guarantee.

The current API has a per-replica cap of 16 admitted requests, 32 outbound
connections, 120 requests/minute globally and 30 requests/minute per observed
source IP; DNS/email/HTTP deadlines are 8/10/12 seconds respectively.
The browser permits an additional bounded 45 seconds for ACA scale-to-zero
activation and transport (53/55/57 seconds total), while those server execution
deadlines remain unchanged. An initial live preview call exceeded the old
11-second DNS browser budget; the warm call completed normally. Cancellation
remains available and there are no automatic retries or calls on page load.
`httpConcurrency` is bounded to 1-15, below that cap. Confirm these contracts
when changing the runtime. A replica-local rate limit may admit up to roughly `maxReplicas` times the
configured per-replica rate across replicas, and state disappears at scale-zero.
`trustProxy=false` deliberately ignores untrusted X-Forwarded-For. ACA's proxy
can aggregate callers under one observed source address, reducing the effective
per-user throughput rather than safely providing independent public-client
buckets. Measure this before public traffic; do not enable blanket trusted
proxy mode to evade the limit. This is not global abuse prevention. Bound outbound operations and payloads in
the API rather than buying Redis by default. CORS does not prevent scripted
non-browser clients from calling a public endpoint.

Readiness/startup/liveness probe `/healthz` on port 8787; startup gets ten
attempts, three seconds apart. Health must be cheap and independent of an
arbitrary external target. Readiness failures remove traffic; sustained liveness
failures restart the process. The image executes Node directly as PID 1 and
ACA grants 30 seconds to drain. The API must handle SIGTERM/SIGINT, stop new
requests and await Fastify close within that interval.

The image runs as non-root UID/GID 65532; root-owned application files cannot be
modified by that user. Docker smoke uses `--read-only`, `--cap-drop=ALL` and
`no-new-privileges`. The selected **stable ACA container schema does not expose
Kubernetes `securityContext`, capability-drop or read-only-rootfs fields**;
they are not silently invented in Bicep. ACA forbids privileged containers.
Do not claim the Docker-only flags are enforced by ACA. Runtime operations must
not need writable application storage, shell execution, elevated privileges or
the Azure pull identity.

Application log export is disabled (`appLogsConfiguration: {}` with no destination;
the East US 2 provider rejects the literal string `none`);
there is no Log Analytics workspace, Application Insights, distributed tracing,
diagnostic setting, Dapr or payload-log sink. Runtime must still disable request
logging and avoid putting user inputs, requested URLs/domains, DNS replies,
headers, cookies or secrets on stdout/stderr. Disabling export does not sanitize
console output: platform live-stream/debug access can expose it. Ordinary Azure
control-plane events, deployment names, health status, aggregate metrics and
registry pull metadata are different from user payloads and remain subject to
Azure's platform retention/access controls. No claim is made that Azure retains
zero operational metadata. Adding logs later requires a privacy/cost review,
explicit short retention (for example 30 days), an ingestion budget and
payload-redaction checks.

## Cloud gates: preview is not deployment

Before **any** command in this section, obtain separate authorization for the
specific phase. Select the subscription, tenant, resource group, ACA location,
SWA-supported location and resource names. Check only that selected context for
permissions, resource providers, regional availability, quota, Azure Policy,
cost and image access. Do not enumerate subscriptions to guess.

Copy the parameter examples to `infra\registry-bootstrap.local.json` and
`infra\main.local.json`; these local files are ignored. Fill every empty value.
The JSON values are literal: `${...}` is not interpolated by Azure CLI.
`imageDigest` must be the registry manifest digest, not a Docker local image ID.
Keep the two names/locations consistent. Never include secrets in parameters.

```powershell
# Values below are intentionally unselected and must be operator-supplied.
$subscriptionId = ''
$resourceGroup = ''
if ([string]::IsNullOrWhiteSpace($subscriptionId) -or [string]::IsNullOrWhiteSpace($resourceGroup)) {
    throw 'Select and approve the Azure context before any cloud command.'
}
.\infra\scripts\Test-Parameters.ps1 -Phase bootstrap -Path .\infra\registry-bootstrap.local.json
# PREVIEW ONLY after approval for selected-context cloud validation:
az deployment group what-if --subscription $subscriptionId --resource-group $resourceGroup --template-file .\infra\registry-bootstrap.bicep --parameters '@infra\registry-bootstrap.local.json'
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap preview failed.' }
```

Stop and review the preview. **The next block creates billable resources and an
RBAC assignment; it is not part of preparation or preview authorization.**
An operator identity with selected-resource-group deployment rights and
registry-scoped role-assignment rights performs bootstrap, not the release
workflow identity.

```powershell
# EXECUTE ONLY AFTER separate bootstrap approval:
az deployment group create --name domos-registry-bootstrap --subscription $subscriptionId --resource-group $resourceGroup --template-file .\infra\registry-bootstrap.bicep --parameters '@infra\registry-bootstrap.local.json' --output none
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap failed.' }
# Read outputs only from this named deployment; no secrets are emitted.
$bootstrap = az deployment group show --name domos-registry-bootstrap --subscription $subscriptionId --resource-group $resourceGroup --query properties.outputs --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read bootstrap outputs.' }
$registryName = $bootstrap.registryName.value
$registryServer = $bootstrap.registryLoginServer.value
```

After approval to publish code/images, build on the reviewed source commit and
record the association between commit, base digest and final image digest.
The builder needs AcrPush on only this registry (or a separately scoped
repository-writer role if intentionally adopting ABAC with matching pull roles).
It is not the application pull identity or production release identity.
Do not use `az acr build` unless the additional ACR Tasks execution/cost has
been explicitly approved.

```powershell
# IMAGE PUBLICATION: separately approved; Linux Docker must be available.
$sourceCommit = git rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'A reviewed source commit is required.' }
if (git status --porcelain) { throw 'Do not publish an uncommitted working tree.' }
$tag = "${registryServer}/diagnostics:${sourceCommit}"
docker build --platform linux/amd64 --file .\infra\containers\diagnostics.Dockerfile --label "org.opencontainers.image.revision=$sourceCommit" --tag $tag .
if ($LASTEXITCODE -ne 0) { throw 'Image build failed.' }
# Uses the approved signed-in Entra identity, not an ACR admin password.
az acr login --subscription $subscriptionId --name $registryName
if ($LASTEXITCODE -ne 0) { throw 'Registry identity login failed.' }
docker push $tag
if ($LASTEXITCODE -ne 0) { throw 'Image publication failed.' }
$imageDigest = az acr repository show --subscription $subscriptionId --name $registryName --image "diagnostics:$sourceCommit" --query digest --output tsv
if ($LASTEXITCODE -ne 0 -or $imageDigest -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'Cannot verify published manifest digest.' }
docker logout $registryServer
```

Put that digest in `main.local.json`. Confirm the image is Linux amd64, all
production gates passed, and AcrPull propagation completed. Authentication
errors are a failed gate, not a reason to enable registry admin access.

```powershell
.\infra\scripts\Test-Parameters.ps1 -Phase main -Path .\infra\main.local.json
# PREVIEW ONLY: do not issue create in the same approval step.
az deployment group what-if --subscription $subscriptionId --resource-group $resourceGroup --template-file .\infra\main.bicep --parameters '@infra\main.local.json'
if ($LASTEXITCODE -ne 0) { throw 'Main preview failed.' }
```

Review the preview, price/quotas and parameter record before a **new, explicit**
authorization for the following resource creation:

```powershell
# EXECUTE ONLY AFTER separate main-infrastructure approval:
az deployment group create --name domos-main --subscription $subscriptionId --resource-group $resourceGroup --template-file .\infra\main.bicep --parameters '@infra\main.local.json' --output none
if ($LASTEXITCODE -ne 0) { throw 'Main deployment failed.' }
az deployment group show --name domos-main --subscription $subscriptionId --resource-group $resourceGroup --query properties.outputs --output json
```

No token is returned by Bicep. Check the *new revision's* readiness and
`apiDefaultOrigin/healthz`; an old healthy revision is not proof the new image
works. A failed first deploy has no old revision to serve.

## Frontend configuration, pre-DNS use and DNS/TLS handoff

Production builds set `PUBLIC_API_ORIGIN=https://api.domosdigial.com` **before**
building `@domos/workspace`; changing SWA runtime settings cannot rewrite a
static bundle. API `CORS_ORIGINS` is the comma-separated exact workspace origin
list, normally `https://tools.domosdigial.com`, never `*`. CORS does not use the
public site hostname because that site must not execute diagnostic calls.

The API has its own hostname; it is **not** an SWA linked backend. Uploads use
the official `Azure/static-web-apps-deploy` action with `app_location` pointing
at each already-built dist, `output_location=''`, `api_location=''` and both
build-skip flags true. This deliberately avoids the SWA linked-backend
45-second request limitation; the API's own much shorter request deadlines
still apply. Do not replace the API with an Azure Function under SWA.

For pre-DNS acceptance, the ACA `apiDefaultOrigin` HTTPS hostname and the
workspace's `workspaceDefaultOrigin` HTTPS hostname are usable after resource
creation and content upload. Set the workspace build's PUBLIC_API_ORIGIN to
that **exact** ACA origin, add the exact temporary SWA workspace origin to
`corsOrigins`/CORS_ORIGINS, and have the frontend owner update/generate workspace
CSP `connect-src` for the same origin before rebuilding. No wildcard ACA/SWA
domain patterns are acceptable. The static-artifact script fails if these
disagree. Keep canonical site metadata/navigation at the approved public
domains unless deliberately doing a separate staging build; temporary-origin
acceptance does not make canonical links or SEO correct before DNS.

The frontend owner must provide `public\staticwebapp.config.json` in each
Astro app so it is copied to dist. Workspace configuration must explicitly
constrain scripts/fonts/frames and permit only its exact API origin for
connections. Local `http://localhost:8787` fallback is development-only; a
production build must reject HTTP. Its post-build security scripts generate
page-specific CSP: all thirteen local tool documents have `connect-src 'none'`;
only the three live workspaces connect to the configured API. These scripts
must be wired into each app's build manifest by the manifest owner, not run as
an undocumented one-off before upload. The API also consumes PUBLIC_API_ORIGIN
for its self-target deny policy; `publicApiOrigin` in Bicep and the release
workflow set it explicitly to match the frontend, avoiding any scaffold default.
Ads remain disabled without publisher IDs
or consent activation; never pass ad activation values during these steps.

Custom-domain operations are **manual handoff, not automated by these
templates/workflows**. After separate authorization and confirmed DNS authority:

1. In each SWA's Custom domains experience, use its own hostname and requested
   ownership TXT record. The apex `domosdigial.com` needs provider-supported
   ALIAS/ANAME/flattening or Azure's documented alternative; do not invent an
   apex CNAME. `tools.domosdigial.com` normally uses its SWA target CNAME.
1. For ACA, verify `api.domosdigial.com` with the requested `asuid.api` TXT value
   (the template returns the app verification ID) and the API app's default
   hostname CNAME. Use the current Azure instructions for the selected binding.
1. Separately authorize the SWA managed certificates and ACA managed certificate
   issuance/binding. Confirm DNS propagation, CAA and certificate eligibility.
   These are not pre-provisioned by this change. Keep custom domains out of
   service until ownership and HTTPS succeed.
1. After the ACA certificate exists in the same environment, put its full
   resource ID into `apiCertificateId` and review a new main what-if before
   binding it to `api.domosdigial.com`. Persist this value for **every subsequent
   main deployment**; leaving it empty intentionally removes the API custom
   binding. SWA custom-domain child resources are managed separately.
1. Rebuild workspace content for the final API origin, restore exact production
   CORS/CSP, verify TLS and remove temporary origins. Do not change any DNS
   records as a side effect of CI or the manual release workflow.

## Manual release workflow setup (not performed)

The workflow has only `workflow_dispatch`; pushes and pull requests do not
deploy, publish images, create preview sites or post comments. Existing Squad
workflows are preserved. The workflow cannot create the infrastructure or fix a
missing Azure context. Its API repository name is deliberately `diagnostics`;
if overriding Bicep's `imageRepository`, update that release contract too.

Before exposing it, create the GitHub **production** Environment with required
reviewers, prevent self-review, and restrict deployment to the protected
default branch. A YAML `environment` reference **does not create protection
rules**. Verify these controls out of band before the first dispatch; no claim
is made that reviewers or federation already exist. Protect changes to infra
and workflows. GitHub OIDC federation must trust precisely
`repo:joseg-ai/boringtools:environment:production` with issuer
`https://token.actions.githubusercontent.com` and audience
`api://AzureADTokenExchange`. No client secret is required.

| Environment variable | Required value |
|---|---|
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Explicit approved OIDC client, tenant and subscription GUIDs |
| `AZURE_RESOURCE_GROUP` | Existing selected resource group |
| `AZURE_ACR_NAME`, `AZURE_ACR_LOGIN_SERVER` | Registry name and exact bootstrap login-server output |
| `AZURE_API_APP_NAME` | Existing Container App name |
| `AZURE_SITE_APP_NAME`, `AZURE_WORKSPACE_APP_NAME` | Two different existing SWA resource names |
| `PUBLIC_API_ORIGIN` | Exact HTTPS final API origin, or approved pre-DNS ACA origin |
| `CORS_ORIGINS` | Exact HTTPS workspace origin(s), comma-separated without spaces |
| Dispatch `image_digest` | Previously built, audited, scanned and approved `sha256:<64 lowercase hex>` |
| Dispatch `authorization` | Literal `DEPLOY`, plus environment reviewer approval |

Assign the release identity only the needed scopes: Container Apps Contributor
on this app (or a narrower custom read/write role), Reader on this registry for
its metadata plus AcrPull for the selected image, and a custom role on **each
SWA** allowing `Microsoft.Web/staticSites/read` and
`Microsoft.Web/staticSites/listSecrets/action`. If the selected role/API
requires further actions, inspect the denied operation and scope a deliberate
addition; do not grant subscription Contributor/Owner. The release job does not
need registry push, role-assignment, identity-management, environment creation,
DNS, certificate or GitHub issue/pull-request write permissions.

OIDC establishes short-lived Azure authentication. **SWA upload still uses its
native deployment token**: the workflow retrieves each existing token via the
scoped identity, masks it immediately, passes it only between steps of the same
job and does not save it to repository secrets or deployment outputs. This is
not a claim that SWA accepts an Azure access token as a deployment token.
The SWA tokens are service credentials, not short-lived OIDC tokens; restrict
listSecrets rights, never echo them or enable shell tracing, and rotate them
through an approved operation if exposed.

The workflow fails on missing values, wrong digest, absent resources,
inaccessible tokens, mismatched CSP or failed new-revision readiness. It
rebuilds site and workspace separately using the selected source commit before
uploading. The operator must verify that this source commit and the chosen API
digest share compatible contracts; digest format/existence cannot establish
that relationship. The action SHAs are pinned, but Azure's SWA action uses an
upstream-controlled deployment-client image internally; this is an explicitly
documented supply-chain boundary, not a fully hermetic uploader.

## Release and recovery gates

Before release, finish the 16-tool acceptance coverage (13 local, 3 live), real
API SSRF/proxy/concurrency controls, production origin enforcement, payload
privacy and ad-free workspace checks. Browser suites belong to the test owner;
CI does not invent an absent e2e contract. Require a measured constrained-image
load run and acceptable cold-start behavior before keeping 0.25 vCPU / 0.5 GiB.
Run approved image scanning and record tested commit/digest associations.

ACA Single revision mode retains the old active revision until the new
revision is ready. Five inactive revisions are retained, but maintain the
previous manifest in ACR as well: an old revision without its image is not a
recovery plan. Roll back through another reviewed manual release using the
previous compatible digest and source commit; default-branch-only workflow
means restoring the reviewed frontend source to that branch first. Do not
delete the registry or rebuild an old mutable tag to simulate rollback.

API update, public upload and workspace upload are **not atomic**. If a later
upload fails, stop, inspect which surface changed and re-release compatible
content deliberately. Avoid automatic destructive rollback or schema changes;
there is no database to migrate. DNS/certificate rollback is a separate
operator action and is never bundled into an application rollback.

Sources: [Container resource/probe limits](https://learn.microsoft.com/azure/container-apps/containers),
[managed-identity image pull](https://learn.microsoft.com/azure/container-apps/managed-identity-image-pull),
[managed-identity lifecycle](https://learn.microsoft.com/azure/container-apps/managed-identity),
[SWA build/upload contract](https://learn.microsoft.com/azure/static-web-apps/build-configuration).
Provenance, pinned dependencies and refresh rules are in `NOTICE.md`.
