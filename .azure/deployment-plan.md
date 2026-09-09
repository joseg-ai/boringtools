# Domos Tools deployment preparation

Status: Deployed

Preview deployment completed. Bootstrap and main each completed azure-validate
before their respective azure-deploy execution. Actual browser/API acceptance,
not ARM success alone, completed the handoff.

## Live preview endpoints

- Site: https://kind-dune-02a76c20f.3.azurestaticapps.net
- Workspaces: https://ashy-tree-0449d5d0f.3.azurestaticapps.net
- API: https://ca-domos-preview-api-eus2.purpletree-afa7a6b0.eastus2.azurecontainerapps.io
- Full resource/provenance/changed-file receipt: `.azure\deployment-receipt.json`.

Recipe: standalone Bicep, using `infra\preview-bootstrap.bicep`,
`infra\registry-bootstrap.bicep` and `infra\main.bicep`.

## Preview authorization and selected context

On 2026-09-08 Jose authorized unattended preview completion, including necessary
local fixes, scoped provisioning, ACR build/source upload, static uploads and
live verification. No Git commits/pushes, DNS, custom-domain bindings,
custom certificates, advertising or unrelated workloads are authorized.

- Subscription: `40907613-5278-48a4-ab10-c9944be31c8b`
  (`ME-MngEnvMCAP823662-joseguajardo-2`).
- Tenant: `3d374b94-78d6-435f-b7a6-b8337c1282b6`.
- API, registry, identity and SWA control-plane region: `eastus2`.
- New resource group: `rg-domos-preview-eus2-40907613`.
- ACR Basic: `domospre40907613eus2`; admin and anonymous pull disabled.
- Pull identity: `id-domos-preview-acrpull-eus2`; registry-scoped AcrPull only.
- Consumption environment: `cae-domos-preview-eus2`; no log export.
- API: `ca-domos-preview-api-eus2`; 0.25 vCPU/0.5 GiB, min 0/max 3,
  HTTP concurrency target 4, no custom domain.
- SWA Standard: `swa-domos-preview-site` and `swa-domos-preview-tools`.
- Preview uses only Azure-generated HTTPS hostnames. The future custom
  domains below remain unchanged but are not preview destinations.
- Existing local servers on ports 4321/4322/8787 must remain undisturbed.

Bootstrap validation uses subscription scope, including the new resource
group and its nested registry/identity deployment. No nonexistent-RG check is
counted as passed. Main validation happens only after bootstrap and image
publication. A successful bootstrap does not validate the application stage.

## Approved scope

- Sixteen IT tools: thirteen browser-local tools and three live diagnostics.
- Future public directory and guides at `domosdigial.com` (not bound).
- Future ad-free workspaces at `tools.domosdigial.com` (not bound).
- Future public diagnostic API at `api.domosdigial.com` (not bound).
- Azure Static Web Apps for the two static frontends.
- Azure Container Apps Consumption for the diagnostic API.
- All specialist agents use GPT-6 Astra.

## Implementation

- [x] Establish shared catalog, contracts, and application scaffolding.
- [x] Implement local tools, isolated browser workers, and diagnostic APIs.
- [x] Implement responsive pages and ad-free tool workspaces.
- [x] Generate container, infrastructure, and delivery configuration.
- [x] Exercise local application behavior and offline deployment artifacts.
- [x] Provision isolated preview resources and deploy the real immutable image.
- [x] Publish and verify both static frontends using generated Azure hostnames.

## Boundaries

Preview provisioning and application publication in the selected context are
approved. Never change the global CLI subscription, sign in interactively,
elevate the operator identity, modify existing workloads, or enable DNS/ads.
All Azure calls explicitly select the subscription and verify its tenant.
No credentials or deployment tokens are written into receipts or logs.

Because no Git commit exists and commits are prohibited, preview image
provenance uses an allowlisted source snapshot and SHA-256 file manifest.
Only required API source and dependency manifests may be uploaded to ACR.
SWA uploads contain built frontend artifacts, never source or local state.

## Design

The working design uses a TypeScript monorepo, Astro static frontends, React
tool interfaces, and an isolated Node API. Local tools must not send their
inputs to a server or persist them automatically. Live tools disclose outbound
processing and enforce target, execution, and response limits. Advertising is
disabled by default and is never loaded into workspace documents.

## Validation and deployment handoff

Each stage follows azure-prepare -> azure-validate -> azure-deploy, with
timestamped proof and a reviewed what-if before writes. Custom-domain checks
are not applicable to this preview and cannot trigger DNS changes.

The local runtime remains Node.js 25.9 and the local Linux Docker daemon remains
unavailable. Authorized ACR builds exercised the actual Node 24.20.0 image,
followed by scanning and live deployment. Initial compute sizing passed the
preview workload but remains unproven for peak production traffic.

### Stage sequence

1. Validate/apply the subscription bootstrap; confirm AcrPull.
2. Build only the allowlisted API snapshot in ACR; validate the Node 24 image.
3. Validate/apply main with the real digest and generated-origin mode. Derive
   workspace CORS from SWA output and API self-origin from environment output.
4. Build both static apps for the exact three generated origins, validate
   artifacts, and upload with transient SWA tokens to the production slot of
   these preview-only resources. GitHub/OIDC is not needed.
5. Check actual homepage/guide/workspace, a local operation, API health and
   real example.com DNS/email/HTTP requests, CORS/CSP and pull identity.
6. Persist nonsecret receipts and limitations; do not claim success from ARM alone.

## All validation checks pass

- [x] Main core validation: CLI, authenticated context, build, resource-group validation and what-if.
- [x] Offline Bicep compilation and linting.
- [x] Main Azure Policy evaluation: resource-group ARM validation and what-if.

The above checklist applies only to the active stage. Pending later-stage
image/runtime/application checks are not waived by bootstrap validation.
Inherited governance policy details are not readable at management-group
scope (403); selected-scope ARM validation/what-if must evaluate actual planned
resources. Any policy denial must be resolved without changing policy or identity.

## Section 7: Validation Proof

The first table is the historical offline handoff; timestamped cloud and live
proof below supersedes its then-pending deployment entries.

| Command / scope | Result |
|---|---|
| `npm run check` | Passed across application workspaces. |
| `npm test` | 316 passed; an initial diagnostics timeout passed on the subsequent run. |
| Root production-header browser suite, Edge | 280 passed across four viewports before the final mobile refinement. |
| Targeted subnet suite after refinement, Edge | 20 passed across four viewports. |
| Independent final mobile-readability review | 4 passed; local handoff approved. |
| Bicep compilation for both entrypoints | Passed offline. |
| Static artifact validator, intended API origin | Passed; a mismatched origin was rejected. |
| Node 24 container execution and image scan | Pending: Linux Docker daemon unavailable. |
| Cloud scope validation, what-if, RBAC and policy checks | Pending operator-selected Azure context and resource approval. |

### Bootstrap proof - 2026-09-08, 6:15-6:17 PM ET

- `validate-deployment.ps1 -Scope sub -Location eastus2 -Template
  .\infra\preview-bootstrap.bicep -Parameters
  .\infra\preview-bootstrap.local.json -Subscription
  40907613-5278-48a4-ab10-c9944be31c8b`: OVERALL PASS. An initial transient
  connection reset on validate was resolved by repeating the same scoped
  request with the same identity. No authentication or policy bypass.
- `az deployment sub what-if` with those same inputs: machine-readable
  `.azure\bootstrap-whatif.json` contains only Create for the new RG, ACR,
  identity and registry-scoped AcrPull assignment. No Modify/Delete.
- Effective caller management actions: `*`; no subscription deny assignments
  returned. Static role review: AcrPull ID
  `7f951dda-4ed3-4680-a7ca-43fe172d538d`, ServicePrincipal type, scope only
  the new registry. No operator role changes.
- Policy assignment inventory was read through Azure MCP. Management-group
  details remain inaccessible, but ARM provider validation and what-if
  successfully evaluated the actual bootstrap payload without policy denial.
- Required provider metadata registered; East US 2 supports the selected
  resource types. New RG absent and registry name available before validation.
- `npm run check --workspace=@domos/site --workspace=@domos/workspace`:
  zero errors/warnings. Targeted origin/security/frontend tests: 21 passed.
- `npm run build`: all three apps built. Existing static artifact validator
  passed for the production-default API origin. Main Bicep compiles offline.
- Build warning: a workspace chunk exceeds 500 kB; no build failure.
- Main ARM validation, published-image runtime checks and live acceptance are
  NOT included in this bootstrap proof and remain pending.

### Bootstrap deployment and image - 2026-09-08, 6:19-6:25 PM ET

- Subscription deployment `domos-preview-bootstrap`: Succeeded; nonsecret
  outputs in `.azure\bootstrap-deployment.json`.
- Azure MCP verified only registry-scoped AcrPull for the new pull identity,
  principal `a080cbfe-16b5-4b58-bb9b-b55975cdf909`.
- ACR is Basic, LegacyRegistryPermissions (RBAC), admin/anonymous disabled;
  ARM-audience authentication enabled (confirmed with current REST schema).
- Remote build `ch1`: Succeeded, linux/amd64; source snapshot
  `e2fd8ba6a2338840d731b7cb16052cd062953e36853bd9676a588e807dc36320`.
  Only 29 reviewed API/dependency-manifest/build files uploaded.
- Image: `domospre40907613eus2.azurecr.io/diagnostics@sha256:048cd44385c9d33107e84fb5b92b1d8eaff770c2fe002468d143fb289e84c03b`.
- Actual image build log: Node 24.20.0 non-root health and SIGTERM smoke
  passed; production npm audit found zero vulnerabilities.
- OS/image vulnerability scan and main validation remain pending.

### Main proof - 2026-09-08, 7:02 PM ET

- Final `validate-deployment.ps1 -Scope group -ResourceGroup
  rg-domos-preview-eus2-40907613 -Template .\infra\main.bicep -Parameters
  .\infra\main.local.json -Subscription
  40907613-5278-48a4-ab10-c9944be31c8b`: OVERALL PASS (CLI/context,
  compilation, provider validation, what-if).
- `.azure\main-whatif.json`: only four new application resources (environment,
  API, two SWAs). Existing preview registry/identity are references, not
  changes. No Modify/Delete. Provider/policy evaluation accepted the actual
  final image/configuration in the selected resource group.
- Actual provider preflight rejected the literal logs destination `none`;
  corrected to an empty `appLogsConfiguration`, then passed validation.
- Final image build `ch7` succeeded on linux/amd64 from the 29-file snapshot
  `c942919f99de18ee7b86ac673f3ea5473eb72ac20c84702799ca3275559bb328`
  (`.azure\preview-source-manifest-v4.json`).
- Final image:
  `domospre40907613eus2.azurecr.io/diagnostics@sha256:c66f6b4beaa2ddf3c06076ed5fad0d15d3d09039b6b499f0d4d4c771616654a6`.
- Earlier full Debian images were not deployed: scanners found unused OS
  utilities and package-manager vulnerabilities. The final runtime is
  digest-pinned Distroless Node 24/Debian 13, UID/GID 65532, no shell/package
  managers. Scanner `ch8` detected Debian 13.6, inspected 14 OS packages and
  Node package metadata, and found ZERO HIGH/CRITICAL vulnerabilities
  (`.azure\image-scan-final.json`). Scanner/database are not in the runtime.
- Final build log: Node 24.20.0 non-root `/healthz` and graceful SIGTERM passed;
  production npm audit zero vulnerabilities (`.azure\image-build-final.json`).
- API type check and targeted app/HTTP regressions: 90 passed, including denial
  of all three configured generated preview hosts.
- Both frontend checks/builds passed in production mode with explicit
  nonproduction origins. Existing artifact validator passed; directory/guide
  navigation, canonical links and per-page API CSP were checked offline.
- Static RBAC review: main uses only the already-provisioned AcrPull identity;
  `lifecycle: None` prevents runtime identity access. No new operator roles.
- Live endpoint/browser acceptance and environment-scoped core quota are
  post-provision gates and are not claimed complete here.

### Live deployment and acceptance - 2026-09-08, 7:47 PM ET

- Main deployment `domos-preview-main`: Succeeded. Requested/ready revision
  `ca-domos-preview-api-eus2--df9jtsq` uses only the final `c66f6b4b...` digest.
  Registry-scoped AcrPull was reconfirmed after deployment through Azure MCP.
- Inventory contains exactly the six planned resources in the new RG, all
  East US 2. No custom domains, DNS, ads, database or extra paid service.
  Application log destination is null; only Consumption profile exists.
  Consumption-core quota is 500; observed usage 0.25, configured replica
  capacity 0.75 vCPU (3 x 0.25), excluding transient revision overlap.
- Actual SWA service validation rejected 308 redirects. Generator now emits
  supported 301 redirects; validator rejects 307/308. Existing fixture/security
  suite plus regression cases: 60 passed. CI workflow was not changed.
- SWA CLI masked native failure exit codes. The local publisher now uses the
  official checksum-verified client, transient environment tokens, isolated
  artifact-only staging, and exact served-index comparison. No tokens persisted.
- Both static apps are live; all 16 tool routes return 200 with correct
  metadata/CSP (13 local no-connect, 3 exact-API live). Canonical/guide/navigation
  links use generated origins. Actual site/guide/workspace HTTP proof retained.
- Live browser: homepage/guide-to-workspace navigation passed; example.com DNS,
  email policy and HTTP all returned complete 200 reports. HTTP target returned
  200. Base64 encoded `Domos preview` to `RG9tb3MgcHJldmlldw==` with zero API calls.
- First browser DNS request took 33.018 seconds including activation, then
  email/HTTP took 509/718 ms wall time. The browser now allows 45 seconds of
  activation/transport in addition to unchanged API operation deadlines.
  Relevant frontend/origin regressions: 19 passed.
- Mobile viewport 390 x 844: site, local and live workspace document widths
  were all 390. No page errors. CSP blocked 12 bundled-code eval attempts;
  unsafe-eval was not enabled, and all operations completed successfully.
- Direct API checks confirmed exact CORS, rejection of unapproved origins,
  and target denial for all three generated app hosts.
- Coordinator ports 4321/4322/8787 remain listening. No Git commits/pushes.
- Standing SWA/ACR charges and ACA/registry/build usage apply; no credit balance
  or fabricated monthly total is claimed. Preview is not a peak-load/SLA claim.
