# Stage 1: Build
# Base image pinned by digest for reproducibility + integrity.
# Refresh manually with: docker buildx imagetools inspect node:26-alpine
# (or query the registry) and update the digest in BOTH stages.
FROM node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8 AS builder

# Pin pnpm via corepack (version comes from package.json "packageManager").
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

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

RUN pnpm --filter @secret/shared build
RUN pnpm --filter @secret/crypto build
RUN pnpm --filter @secret/sdk-js build
RUN pnpm --filter @secret/web build
RUN pnpm --filter @secret/api build

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
FROM node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8 AS production

RUN adduser -D -u 1001 appuser

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY --from=builder /build/package.json /build/pnpm-workspace.yaml /build/pnpm-lock.yaml ./
COPY --from=builder /build/packages/shared/package.json packages/shared/
COPY --from=builder /build/packages/crypto/package.json packages/crypto/
COPY --from=builder /build/packages/sdk-js/package.json packages/sdk-js/
COPY --from=builder /build/apps/api/package.json apps/api/
COPY --from=builder /build/apps/web/package.json apps/web/

# Install prod deps, then strip the pnpm store/caches (runtime never invokes pnpm).
RUN pnpm install --frozen-lockfile --prod && \
	pnpm store prune 2>/dev/null || true && \
	rm -rf ~/.local/share/pnpm ~/.cache /root/.npm 2>/dev/null || true

COPY --from=builder /build/packages/shared/dist packages/shared/dist
COPY --from=builder /build/packages/crypto/dist packages/crypto/dist
COPY --from=builder /build/packages/sdk-js/dist packages/sdk-js/dist
COPY --from=builder /build/apps/api/dist apps/api/dist
COPY --from=builder /build/apps/web/build apps/web/build
COPY entrypoint.sh ./

RUN mkdir -p /app/data/files && chown -R appuser:appuser /app/data

USER 1001

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/secret.db
ENV FILES_PATH=/app/data/files

EXPOSE 3000

# Node-based healthcheck avoids shipping curl (smaller image, less attack surface).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "entrypoint.sh"]
