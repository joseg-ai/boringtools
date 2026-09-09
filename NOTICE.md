# Third-party notices

Direct dependency metadata was retrieved from npm on **2026-09-08**. Versions
below are intentionally pinned, including stable compatible releases instead of
prerelease dist-tags. `package-lock.json` records the installed dependency tree.
These are package dependencies, not copied source files or catalog ports.

Each upstream retains its copyright. The installed package's `LICENSE`,
`LICENSE.md`, `LICENSE.txt`, `COPYING` or equivalent license notice is the
authoritative copyright/license text and must be retained with redistribution.
This document does not relicense upstream work or supply a project license.
Transitive packages retain their own notices in the installed dependency tree.

## Runtime and development dependencies

| Packages and pinned versions | Upstream / copyright attribution | License metadata | Consumer / in-tree declaration |
|---|---|---|---|
| `astro` 7.2.10; `@astrojs/react` 6.0.5; `@astrojs/check` 0.9.10; `@astrojs/markdown-remark` 7.3.0 | [Fred K. Schott / Astro contributors](https://github.com/withastro/astro); bundled notices also credit SvelteKit contributors and Yuxi (Evan) You / Vite contributors | MIT | `apps\site\package.json`, `apps\workspace\package.json`; root check tooling |
| `react`, `react-dom` 19.2.8 | [Meta Platforms, Inc. and affiliates / React contributors](https://github.com/facebook/react) | MIT | Both frontend manifests |
| `fastify` 5.12.1 | [The Fastify team](https://github.com/fastify/fastify) (2016-present) | MIT | `apps\diagnostics\package.json` |
| `@fastify/cors` 11.3.0 | [The Fastify team](https://github.com/fastify/fastify-cors) (2018-present) | MIT | Diagnostics cross-origin policy |
| `@fastify/rate-limit` 11.2.0 | [The Fastify team](https://github.com/fastify/fastify-rate-limit) (2018-present) | MIT | Diagnostics replica-local request limits |
| `zod` 4.5.4 | [Colin McDonnell / Zod contributors](https://github.com/colinhacks/zod) | MIT | `packages\contracts\package.json`; API configuration |
| `ipaddr.js` 2.5.0 | [whitequark / ipaddr.js contributors](https://github.com/whitequark/ipaddr.js) | MIT | Tool core and diagnostics IP parsing |
| `dns-packet` 5.6.1 | [Mathias Buus / dns-packet contributors](https://github.com/mafintosh/dns-packet) | MIT | Diagnostics controlled DNS wire format |
| `tldts` 7.4.11 | [Thomas Parisot (2017), Remi Berson (2018)](https://github.com/remusao/tldts) | MIT | Diagnostics organizational-domain handling |
| `yaml` 2.9.0 | [Eemeli Aro](https://github.com/eemeli/yaml) | ISC | `packages\tool-core\package.json` |
| `lossless-json` 4.3.1 | [Jos de Jong](https://github.com/josdejong/lossless-json) | MIT | Tool core numeric-preserving JSON handling |
| `cron-parser` 5.10.0 | [Harri Siirak](https://github.com/harrisiirak/cron-parser) (2014-2023) | MIT | Tool core timezone-aware recurrence |
| `diff` 9.0.0 | [Kevin Decker / jsdiff contributors](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Tool core text comparison |
| `postal-mime` 3.0.0 | [Andris Reinman / Postal Systems](https://github.com/postalsys/postal-mime) | MIT-0 | Tool core header decoding |
| `@noble/hashes` 2.4.0 | [Paul Miller](https://github.com/paulmillr/noble-hashes) | MIT | Tool core incremental SHA |
| `@scure/bip39` 2.4.0 | [Patricio Palladino and Paul Miller](https://github.com/paulmillr/scure-bip39) (2022) | MIT | Tool core licensed English passphrase wordlist; preserve bundled wordlist notices |
| `typescript` 6.0.3 | [Microsoft Corporation](https://github.com/microsoft/TypeScript) | Apache-2.0 | Root TypeScript tooling; compatible with Astro check peer range |
| `@types/node` 24.13.3; `@types/react` 19.2.18; `@types/react-dom` 19.2.5; `@types/dns-packet` 5.6.5 | [DefinitelyTyped contributors](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Root and diagnostics development types |
| `vitest` 4.1.11 | [VoidZero Inc. and Vitest contributors](https://github.com/vitest-dev/vitest) (2021-present); retain its bundled notices | MIT | Root unit/integration runner |
| `@playwright/test` 1.63.0 | [Microsoft Corporation](https://github.com/microsoft/playwright) | Apache-2.0 | Root browser acceptance tooling |
| `esbuild` 0.28.2 | [Evan Wallace](https://github.com/evanw/esbuild) | MIT | Isolated bundled diagnostics build |
| `tsx` 4.23.13 | [Hiroki Osame](https://github.com/privatenumber/tsx) | MIT | Diagnostics TypeScript development entry |

**Sync rule for every dependency above:** update deliberately through npm,
review the upstream changelog and license, update this table and the lockfile
together, and exercise affected contracts/consumers. No automatic upstream
source synchronization is configured. Package-specific notices remain
authoritative if a registry summary differs.

## Deployment provenance

The Bicep, container assembly and release scripts are original project code,
not copies of upstream templates. Microsoft Learn and the installed
`azure-prepare` Bicep/Container Apps/Static Web Apps reference material informed
resource properties and the deployment sequence; no skill template is bundled.
In particular, the placeholder-container bootstrap pattern was not adopted.

| Source / owner | Version or retrieval | License / scope | Consumer and refresh rule |
|---|---|---|---|
| [Microsoft Learn: Container Apps containers](https://learn.microsoft.com/azure/container-apps/containers), [managed identity image pull](https://learn.microsoft.com/azure/container-apps/managed-identity-image-pull), [managed identity lifecycle](https://learn.microsoft.com/azure/container-apps/managed-identity), [plans](https://learn.microsoft.com/azure/container-apps/plans), [SWA build configuration](https://learn.microsoft.com/azure/static-web-apps/build-configuration); Microsoft | Retrieved 2026-09-08; ARM schemas queried through Azure MCP | Documentation reference only; Microsoft retains rights; no documentation text or sample files copied | `infra`, `docs\deployment.md`, delivery workflows; recheck on API version/service-policy changes |
| [Node Docker Official Image](https://github.com/nodejs/docker-node); Node Docker contributors | `24-trixie-slim` index `sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0`; upstream source `c4eb0858f5c522521768d5b6dc1d9f1631d4854d`; resolved 2026-09-08 | MIT Docker source; Node and Debian components retain their bundled notices/licenses | `infra\containers\diagnostics.Dockerfile` build/dependency stages; deliberately refresh digest, audit dependencies and rebuild before promotion |
| [Distroless](https://github.com/GoogleContainerTools/distroless); Google and contributors | `nodejs24-debian13:nonroot` index `sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79`; resolved 2026-09-08 | Apache-2.0 assembly; Node and Debian components retain their bundled notices/licenses | `infra\containers\diagnostics.Dockerfile` runtime; refresh immutable digest and rescan before promotion; no shell or package managers required by the app |
| [Trivy](https://github.com/aquasecurity/trivy); Aqua Security and contributors | 0.74.0, linux/amd64 image `sha256:ee940acbf1f58ebadb42d01434ce4609530bf1b52536afbd1eee66cd7123c5c9`; resolved 2026-09-08 | Apache-2.0; invoked in a transient scan, not copied into the application image | Preview image scan receipt in `.azure`; refresh scanner/database and rescan the immutable app digest before promotion |
| [Azure Static Web Apps CLI](https://github.com/Azure/static-web-apps-cli); Microsoft and contributors | CLI 2.0.8; official deployment client build `689a6c1fe8fc32f40348cc41223a7e9d83dd43d2`, Windows SHA-256 `58bc6533b9cbdd1d9564d3f36625308f4b20ec5a0c51b093cb35e4bf61545f82`; inspected 2026-09-08 | MIT CLI; Microsoft deployment client retains its distribution terms; invoked, not bundled | `infra\scripts\Publish-PreviewStatic.ps1` uses the CLI's native environment contract; verify official client checksum and compatibility on updates |
| [actions/checkout](https://github.com/actions/checkout); GitHub | v5 `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | MIT; invoked, not copied | CI and manual release workflow; update pinned commit after upstream release review |
| [actions/setup-node](https://github.com/actions/setup-node); GitHub | v6 `249970729cb0ef3589644e2896645e5dc5ba9c38` | MIT; invoked, not copied | CI and manual release workflow; update pinned commit after upstream release review |
| [Azure/login](https://github.com/Azure/login); Microsoft | v3 `4c03e4685fe81df2c50d5714c7d93cf39d8deb7f` | MIT; invoked, not copied | Manual release workflow OIDC login; review permissions and pin on update |
| [Azure/static-web-apps-deploy](https://github.com/Azure/static-web-apps-deploy); Microsoft | v1 branch commit `4d27395796ac319302594769cfe812bd207490b1`, resolved 2026-09-08 (the historical v1 tag is older) | MIT; invoked, not copied | Manual release workflow standard prebuilt upload; recheck supported inputs when updating. The action's underlying Microsoft deployment-client image is upstream-controlled, not made immutable by the action SHA |

## Pattern inspiration

| Source | Scope | Provenance / refresh |
|---|---|---|
| [Nutilz](https://nutilz.com/#tools) | Broad utility directory functionality | User-provided inspiration, recorded 2026-09-08; no code, prose or visual design copied |
| [Visual Subnet Calculator](https://visualsubnetcalc.com/) | Visual IPv4 split/join allocation workflow | User-provided inspiration, recorded 2026-09-08; independent implementation required |
| [MXToolbox](https://mxtoolbox.com/) | DNS and mail-policy diagnostic use cases | User-provided inspiration, recorded 2026-09-08; no source/content license asserted |
| [boring-tool.com](https://boring-tool.com/) | Utility-site product concept | User-provided inspiration, recorded 2026-09-08; original Domos branding, content and UI |

These reference sites are not bundled dependencies. Their respective owners
retain all rights. Revisit only for functional research; there is no content
mirroring or source refresh process.
