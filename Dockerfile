# Stage 1: Build
# Base image pinned by digest for reproducibility + integrity.
# Refresh manually with: docker buildx imagetools inspect node:26-alpine
# (or query the registry) and update the digest in BOTH stages.
FROM node:26-alpine@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS builder

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
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY messages/ messages/

RUN pnpm --filter @largerio/secret-shared build
RUN pnpm --filter @largerio/secret-crypto build
RUN pnpm --filter @largerio/secret-sdk build
RUN pnpm --filter @largerio/web build
RUN pnpm --filter @largerio/api build

# Rewrite package exports from .ts sources to compiled .js dist
RUN node -e " \
  const fs = require('fs'); \
  for (const pkg of ['packages/shared', 'packages/crypto', 'packages/sdk-js']) { \
    const p = JSON.parse(fs.readFileSync(pkg + '/package.json', 'utf8')); \
    const rewrite = (v) => v.replace('./src/', './dist/').replace('.ts', '.js'); \
    if (typeof p.exports === 'string') { p.exports = rewrite(p.exports); } \
    else { for (const k of Object.keys(p.exports)) { p.exports[k] = rewrite(p.exports[k]); } } \
    fs.writeFileSync(pkg + '/package.json', JSON.stringify(p, null, 2)); \
  }"

# Stage 2: Production
FROM node:26-alpine@sha256:144769ec3f32e8ee36b3cfde91e82bee25d9367b20f31a151f3f7eea3a2a8541 AS production

# CVE-2026-45447: the pinned base image still ships openssl 3.5.6-r0; pull the
# fixed 3.5.7-r0 from the Alpine repos until upstream node:26-alpine is rebuilt.
# Remove once a refreshed digest includes openssl >= 3.5.7-r0.
RUN apk upgrade --no-cache libssl3 libcrypto3

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
COPY --from=builder /build/packages/sdk-js/package.json packages/sdk-js/
COPY --from=builder /build/apps/api/package.json apps/api/
COPY --from=builder /build/apps/web/package.json apps/web/

# Install prod deps, then strip the pnpm store/caches (runtime never invokes pnpm).
# Kept as two layers on purpose: `a && b || true && c || true` parses as
# `(((a && b) || true) && c) || true`, which exits 0 even when the install
# fails — publishing an image with no node_modules at all.
RUN pnpm install --frozen-lockfile --prod
RUN { pnpm store prune || true; } && \
	rm -rf ~/.local/share/pnpm ~/.cache /root/.npm || true

COPY --from=builder /build/packages/shared/dist packages/shared/dist
COPY --from=builder /build/packages/crypto/dist packages/crypto/dist
COPY --from=builder /build/packages/sdk-js/dist packages/sdk-js/dist
COPY --from=builder /build/apps/api/dist apps/api/dist
COPY --from=builder /build/apps/web/build apps/web/build
COPY entrypoint.sh ./

RUN mkdir -p /app/data/files && chown -R appuser:appuser /app/data

USER 1001

ENV NODE_ENV=production
# PORT is deliberately unset: it means "the port the site is served on", the one
# a PaaS injects. entrypoint.sh gives the API its own host and port.
ENV DATABASE_PATH=/app/data/secret.db
ENV FILES_PATH=/app/data/files

EXPOSE 3000

# Node-based healthcheck avoids shipping curl (smaller image, less attack surface).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "entrypoint.sh"]
