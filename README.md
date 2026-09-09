# Domos Tools

An original, responsive IT toolkit with sixteen tools: thirteen run locally in
the browser and three use a bounded diagnostics API. This repository contains
the application and Azure deployment configuration, not a deployed service.

## Tools

| Category | Tools |
|---|---|
| Networking | Visual IPv4 subnet planner, DNS explorer, email DNS policy inspector, HTTP response inspector |
| Administration | Email-header analyzer, chmod calculator |
| Security utilities | Password/passphrase generator, unverified JWT decoder, SHA checksums |
| Developer utilities | JSON/YAML workbench, Base64 codec, URL workbench, regex tester, text diff |
| Time | Five-field cron helper, epoch/time converter |

The subnet planner supports split/join operations, notes, colors, JSON
import/export and CSV export. There are sixteen original guides, a searchable
directory, light/dark themes, and layouts for phones, tablets and desktops.

## Application boundaries

| Package | Path | Responsibility |
|---|---|---|
| `@domos/site` | `apps\site` | Static public directory, original guides, privacy and about pages |
| `@domos/workspace` | `apps\workspace` | Ad-free Astro documents with individual React tool islands |
| `@domos/diagnostics` | `apps\diagnostics` | Isolated Fastify live diagnostics API |
| `@domos/catalog` | `packages\catalog` | Metadata only; no tool implementation imports |
| `@domos/contracts` | `packages\contracts` | Strict runtime schemas and derived TypeScript interfaces |
| `@domos/tool-core` | `packages\tool-core` | Browser-local algorithms and terminable workers |

The hosting target is two Azure Static Web Apps and an Azure Container Apps
Consumption API, not AKS. Public addresses are `https://domosdigial.com`,
`https://tools.domosdigial.com`, and `https://api.domosdigial.com`. Provisioning,
deployment, DNS changes and advertising activation require separate approval.

Local tools do not transmit or automatically persist inputs. Workspace
documents do not load ads, analytics, third-party scripts or remote fonts.
Navigation between tools is full-document navigation, without an Astro client
router. Live tools disclose their outbound processing. Advertising remains off,
including on the public site, until publisher approval and consent requirements
have been satisfied. There are no accounts, database or server-side history.
The theme preference may be stored locally; tool inputs are not.

## Local development

Use **Node.js 24 LTS** and npm 11. Run from the repository root:

```powershell
npm ci
npm run dev:site
# In another terminal:
npm run dev:workspace
# In another terminal:
npm run dev:api
```

Site: `http://localhost:4321`; workspace: `http://localhost:4322`;
API: `http://localhost:8787`. `/healthz` reports service readiness. Live tools
perform real public-target lookups only after submission; local tools do not
call the API.

| Variable | Consumer | Contract |
|---|---|---|
| `PUBLIC_API_ORIGIN` | Workspace build and API | Workspace defaults to `http://localhost:8787` in development and `https://api.domosdigial.com` in production. The API uses the production origin to block self-inspection. Never derived from tool input. |
| `CORS_ORIGINS` | API | Comma-separated exact origins; defaults to `https://tools.domosdigial.com` in production and `http://localhost:4322` in development. No wildcard or credentialed CORS. |
| `HOST` | API | Bind address; defaults to `127.0.0.1` in development and `0.0.0.0` in production. |
| `PORT` | API | TCP port; default `8787`. |
| `NODE_ENV` | API | `development`, `test` or `production`. |
| `CONTAINER_APP_HOSTNAME` | API | Azure's application hostname, also blocked as an inspection target when supplied. |
| `ASTRO_TELEMETRY_DISABLED` | Local build tooling | Set `1` to disable Astro CLI telemetry; not a browser script. |

Use explicit local `.env` files when needed; they are ignored by Git. Do not put
tool inputs or credentials in environment examples.

```powershell
npm run check:foundation
npm run test:foundation
npm run check
npm test
npm run build
npm run test:e2e
```

The first two commands cover the shared catalog and contracts. Both frontend
builds also generate the production script-hash Content Security Policies and
Static Web Apps configuration; do not publish an unprocessed Astro build.
Playwright browsers are installed separately when required:
`npx playwright install chromium`.

## Deployment preparation

Deployable preparation lives in `infra`: ACR/identity bootstrap, a
Consumption-only API environment, two Standard Static Web Apps, and a
digest-pinned Node 24 container. See [the deployment runbook](docs/deployment.md)
for Windows commands, local checks, explicit cloud approval gates, DNS/TLS
handoff and rollback.

CI builds and checks code on pushes and pull requests, but never publishes.
`deploy-manual.yml` only releases an already-approved ACR digest to existing
resources after manual dispatch and protected `production` environment approval.
No Azure context has been selected, resources provisioned, domains bound or
advertising enabled. Image creation and cloud readiness still require the
runbook's runtime, permission, quota and deployment-preview steps.

## Shared interfaces

`packages\catalog\src\index.ts` exports `TOOL_IDS`, `TOOL_MODES`, `LOCAL_TOOL_IDS`,
`LIVE_TOOL_IDS`, `TOOL_CATALOG` and `getTool`. Metadata uses `/tools/<id>/` and
`/guides/<id>/` routes and contains no runtime tool or server imports.

`packages\contracts\src\index.ts` is the public schema/type entry. The schemas
are authoritative, reject unknown properties, and supply documented defaults.
Contract version 1 keeps frontend, algorithm and API behavior aligned; update
its consumers and regression coverage together when changing a contract.
`local.ts` defines every local input and output; `subnet.ts` defines versioned
allocations and split/join/import/export commands; `execution.ts` defines the
algorithm facade, file hashing, cancellation, progress and worker messages.
Implementations belong in `@domos/tool-core`, not in the contracts package.

The required core facade is `executeLocalTool(id, input, context?)`, returning
`Promise<LocalToolResult<typeof id>>`. It takes `LocalToolInput<K>` and returns
validated `LocalToolOutput<K>` on success. `hashFile(blob, options, context?)`
uses the same result shape for `sha-checksums`. Expected input, timeout, limit,
unsupported-feature and cancellation errors are explicit results. Unexpected
programming errors reject; they must not be swallowed as empty successes.
The facade lazily imports the selected algorithm rather than loading all
thirteen implementations into every island.

The runtime export locations are
`packages\tool-core\src\index.ts` (`executeLocalTool`, `hashFile`),
`packages\tool-core\src\workers\index.ts` (`createWorkerClient`) and
`packages\tool-core\src\workers\entry.ts` (module-worker dispatcher). Worker requests and responses
use `jobId`; cancellation terminates the worker instead of sending a message a
blocked regular expression cannot process.

Schema limits apply in addition to algorithmic limits: general text is 1 MiB,
serialized local replies 2 MiB, files 250 MiB, and HTTP/API replies 256 KiB.
Regex uses a 1-second worker deadline; diff uses 2 seconds. File hashing has a
120-second worker deadline and 1 MiB chunks. A limit must become a visible
`LIMIT_EXCEEDED` result, never silent truncation (except the explicitly marked
regex match-count `truncated` flag).

Cron accepts exactly five standard fields with lists, ranges, steps and
month/day names, not seconds or `L`, `W`, `#`, `?` or `@` extensions. Its timezone
and DST behavior follow the pinned `cron-parser`; no custom DST semantics are
promised. Epoch conversion requires explicit units; ISO input requires an
offset or `Z` and no more than millisecond precision. There is no ambiguous
local-wall-time parser. Symbolic chmod requires an explicit starting octal
mode and explicit `u/g/o/a` targets with `+`, `-` or `=` and `rwxst`;
conditional `X` and class copying are not supported in this contract.

`api.ts` defines POST `/api/v1/dns`, `/api/v1/email-policy` and `/api/v1/http`.
Replies discriminate `kind: "result" | "partial" | "error"` and contain `meta`;
successful/partial replies carry `data`, partial/error replies carry `error`.
Negative DNS observations are data, not service errors. SPF/DMARC/DKIM reports
are partial observations, never a deliverability or authentication certificate.
HTTP responses expose bounded hop data, never inspected cookies or redirects
as the API's own response headers. Error-only responses use the exported
`API_ERROR_HTTP_STATUS` map; result and partial observations use HTTP 200.
Production handlers enforce public-target restrictions, address pinning,
request deadlines, exact CORS and per-replica rate/concurrency limits; schemas
alone do not provide those protections. Limits multiply with replicas and
untrusted platform proxies can aggregate callers under a single source IP.

Workspace live components consume `API_ORIGIN` from
`apps\workspace\src\config.ts`, backed by `astro:env/client`. Its schema accepts
an exact configured HTTPS origin (HTTP only for local loopback), with no path,
credentials, query or trailing slash. Never build an API origin from user input
or use a same-origin Static Web Apps backend assumption.

## Adding a tool

1. Add its metadata and privacy mode to `packages\catalog`.
2. Define and exercise its input/output contracts in `packages\contracts`.
3. Implement its local engine in `packages\tool-core`, or an explicitly bounded
   live endpoint in `apps\diagnostics`.
4. Add its workspace interface, original guide and browser scenarios. Update
   the catalog-count assertions deliberately when expanding the release.

## Built On + Thanks

### Deployment foundations

[Azure Container Apps](https://learn.microsoft.com/azure/container-apps/containers),
[managed-identity image pulls](https://learn.microsoft.com/azure/container-apps/managed-identity-image-pull)
and [Static Web Apps build configuration](https://learn.microsoft.com/azure/static-web-apps/build-configuration)
inform the original deployment configuration. Delivery uses the official
[Node 24 build image](https://github.com/nodejs/docker-node),
[Distroless Node 24 runtime](https://github.com/GoogleContainerTools/distroless),
[checkout](https://github.com/actions/checkout),
[setup-node](https://github.com/actions/setup-node),
[Azure login](https://github.com/Azure/login) and
[Static Web Apps upload](https://github.com/Azure/static-web-apps-deploy)
actions. Deployment provenance and refresh rules are in `NOTICE.md`.
Preview image vulnerability scanning uses [Trivy](https://github.com/aquasecurity/trivy)
in a separate transient build; the scanner is not shipped in the runtime image.
Local previews use the official deployment client distributed by
[Azure Static Web Apps CLI](https://github.com/Azure/static-web-apps-cli).

### Functionality inspiration only

[Nutilz](https://nutilz.com/#tools),
[Visual Subnet Calculator](https://visualsubnetcalc.com/),
[MXToolbox](https://mxtoolbox.com/) and
[boring-tool.com](https://boring-tool.com/) informed the selection of useful
utilities. No source, design, branding or prose was copied. These acknowledgments
do not grant a license to those sites' content.

### Runtime, tooling and library foundations

- [Astro](https://github.com/withastro/astro) and [React](https://github.com/facebook/react) for static documents and isolated interactive interfaces.
- [Fastify](https://github.com/fastify/fastify), [CORS](https://github.com/fastify/fastify-cors) and [rate limiting](https://github.com/fastify/fastify-rate-limit) for the API foundation.
- [Zod](https://github.com/colinhacks/zod) for shared runtime contracts.
- [ipaddr.js](https://github.com/whitequark/ipaddr.js), [dns-packet](https://github.com/mafintosh/dns-packet) and [tldts](https://github.com/remusao/tldts) for network format and domain handling.
- [YAML](https://github.com/eemeli/yaml), [lossless-json](https://github.com/josdejong/lossless-json), [cron-parser](https://github.com/harrisiirak/cron-parser), [jsdiff](https://github.com/kpdecker/jsdiff) and [PostalMime](https://github.com/postalsys/postal-mime) for local parsing and transformations.
- [noble-hashes](https://github.com/paulmillr/noble-hashes) for incremental hashing and [scure-bip39](https://github.com/paulmillr/scure-bip39) for its licensed English wordlist, not wallet generation.
- [TypeScript](https://github.com/microsoft/TypeScript), [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped), [Vitest](https://github.com/vitest-dev/vitest), [Playwright](https://github.com/microsoft/playwright), [esbuild](https://github.com/evanw/esbuild) and [tsx](https://github.com/privatenumber/tsx) for development and verification.

Exact direct dependency versions, license metadata, scope and refresh rules are
recorded in [NOTICE.md](NOTICE.md). Original project code has no license grant
until the owner chooses one; third-party dependencies retain their own licenses.
