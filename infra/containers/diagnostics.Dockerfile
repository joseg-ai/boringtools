# Original assembly; Node/Distroless image provenance and refresh policy: NOTICE.md.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79
FROM ${NODE_IMAGE} AS manifests
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
COPY packages/catalog/package.json ./packages/catalog/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/tool-core/package.json ./packages/tool-core/
COPY apps/site/package.json ./apps/site/
COPY apps/workspace/package.json ./apps/workspace/
COPY apps/diagnostics/package.json ./apps/diagnostics/

FROM manifests AS build
RUN npm ci --workspace=@domos/diagnostics --include-workspace-root --no-audit --no-fund
COPY packages/catalog/src ./packages/catalog/src
COPY packages/contracts/src ./packages/contracts/src
COPY apps/diagnostics/src ./apps/diagnostics/src
COPY apps/diagnostics/scripts ./apps/diagnostics/scripts
RUN npm run build --workspace=@domos/diagnostics

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --ignore-scripts --workspace=@domos/diagnostics --include-workspace-root=false --no-audit --no-fund \
    && npm audit --omit=dev --workspace=@domos/diagnostics --include-workspace-root=false --audit-level=high \
    && rm -rf /build/node_modules/@domos

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 PUBLIC_API_ORIGIN=https://api.domosdigial.com
ENV PATH=/nodejs/bin:${PATH}
WORKDIR /app
COPY --from=production-dependencies /build/node_modules ./node_modules
# Preserve any workspace-local external npm dependencies, not just hoisted ones.
COPY --from=production-dependencies /build/apps/diagnostics ./apps/diagnostics
COPY --from=build /build/apps/diagnostics/dist ./apps/diagnostics/dist
COPY --from=build /build/apps/diagnostics/scripts/container-smoke.mjs ./apps/diagnostics/scripts/container-smoke.mjs
USER 65532:65532
RUN ["/nodejs/bin/node", "apps/diagnostics/scripts/container-smoke.mjs"]
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(2000)}).then(async r=>{const b=await r.json();process.exit(r.ok&&b.service==='domos-diagnostics'&&b.status==='ok'?0:1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["apps/diagnostics/dist/server.mjs"]
