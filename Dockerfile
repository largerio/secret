# Stage 1: Build
# The base is pinned by digest, the same in both stages: CI refuses a mix
# (.github/scripts/base-image.sh). Dependabot bumps it on main, and
# rebuild-release.yml rebuilds the latest release on a newer one.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder

# Install corepack (not bundled in node:26-alpine) and enable it; the pnpm
# version is resolved from package.json "packageManager", so Dependabot's npm
# updates keep it in sync (single source of truth).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@0.35.0 && corepack enable

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY messages/ messages/

# What the image runs: the API, its workspace packages, and the web app as
# static files in apps/web/build, bundle.json included. CI checks that a build
# of the same commit outside this image gives the same bundle
# (.github/scripts/bundle-reproducible.sh).
RUN pnpm --filter @largerio/secret-shared build
RUN pnpm --filter @largerio/secret-crypto build
RUN pnpm --filter @largerio/web build
RUN pnpm --filter @largerio/api build

# Rewrite package exports from .ts sources to compiled .js dist, every subpath
# included (the shared package's ./site, ./bundle, ./accent...).
RUN node -e " \
  const fs = require('fs'); \
  for (const pkg of ['packages/shared', 'packages/crypto']) { \
    const p = JSON.parse(fs.readFileSync(pkg + '/package.json', 'utf8')); \
    const rewrite = (v) => v.replace('./src/', './dist/').replace('.ts', '.js'); \
    if (typeof p.exports === 'string') { p.exports = rewrite(p.exports); } \
    else { for (const k of Object.keys(p.exports)) { p.exports[k] = rewrite(p.exports[k]); } } \
    fs.writeFileSync(pkg + '/package.json', JSON.stringify(p, null, 2)); \
  }"

# Stage 2: Production
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS production

RUN adduser -D -u 1001 appuser

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# corepack (pnpm) is the only package manager used here; npm is needed solely to
# bootstrap corepack and is never invoked at runtime. Drop it from the final image
# so it also drops npm's bundled undici (flagged by Trivy, e.g. CVE-2026-12151).
# The Node runtime's built-in undici and the app's own undici are unaffected.
RUN npm install -g corepack@0.35.0 && corepack enable && \
	rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /build/package.json /build/pnpm-workspace.yaml /build/pnpm-lock.yaml ./
COPY --from=builder /build/packages/shared/package.json packages/shared/
COPY --from=builder /build/packages/crypto/package.json packages/crypto/
COPY --from=builder /build/apps/api/package.json apps/api/

# Install the prod deps of the API and its workspace packages, nothing else: the
# web app needs none at runtime, and the SDK and the CLI only serve the API's
# tests. Their package.json files are left out, so pnpm skips them, as it skips
# the e2e suite's. Then strip the pnpm store/caches (runtime never invokes pnpm).
# Kept as two layers on purpose: `a && b || true && c || true` parses as
# `(((a && b) || true) && c) || true`, which exits 0 even when the install
# fails — publishing an image with no node_modules at all.
RUN pnpm --filter "@largerio/api..." install --frozen-lockfile --prod
RUN { pnpm store prune || true; } && \
	rm -rf ~/.local/share/pnpm ~/.cache /root/.npm || true

COPY --from=builder /build/packages/shared/dist packages/shared/dist
COPY --from=builder /build/packages/crypto/dist packages/crypto/dist
COPY --from=builder /build/apps/api/dist apps/api/dist
# The API serves the web app from apps/web/build, and reads the pages' heads in
# every language from messages/: both found from apps/api/dist.
COPY --from=builder /build/apps/web/build apps/web/build
COPY --from=builder /build/messages messages
# The API reads its version from the changelog (apps/api/src/buildInfo.ts).
COPY entrypoint.sh CHANGELOG.md ./

RUN mkdir -p /app/data/files && chown -R appuser:appuser /app/data

USER 1001

ENV NODE_ENV=production
# PORT is deliberately unset: it is the one a PaaS injects, and the API
# defaults it to 3000, as the HEALTHCHECK below does.
ENV DATABASE_PATH=/app/data/secret.db
ENV FILES_PATH=/app/data/files

EXPOSE 3000

# The commit built, and whether it is the release CHANGELOG.md names: true, or
# false for a later commit of main, which then reports <version>-dev. CI passes
# both (deploy.yml, rebuild-release.yml). A build without them reports the
# changelog's version and an unknown revision. Last, so a new commit rebuilds
# nothing.
ARG REVISION=""
ARG RELEASE=""
ENV BUILD_REVISION=$REVISION BUILD_RELEASE=$RELEASE

# Node-based healthcheck avoids shipping curl (smaller image, less attack surface).
# Liveness, on the port the site is served on: the app answers. Not readiness:
# proxies that route by Docker's health status, such as Traefik, drop an
# unhealthy container, and a slow storage would take the whole site down, text
# notes included. The deploy checks readiness on its own.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "entrypoint.sh"]
