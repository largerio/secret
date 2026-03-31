# Stage 1: Build
FROM node:24-alpine AS builder

RUN corepack enable pnpm

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY messages/ messages/

RUN pnpm --filter @secret/web build
RUN pnpm --filter @secret/api build

# Stage 2: Production
FROM node:24-alpine AS production

RUN adduser -D -u 1001 appuser

WORKDIR /app

RUN corepack enable pnpm

COPY --from=builder /build/package.json /build/pnpm-workspace.yaml /build/pnpm-lock.yaml ./
COPY --from=builder /build/packages/shared/package.json packages/shared/
COPY --from=builder /build/packages/crypto/package.json packages/crypto/
COPY --from=builder /build/apps/api/package.json apps/api/
COPY --from=builder /build/apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /build/packages/shared/src packages/shared/src
COPY --from=builder /build/packages/crypto/src packages/crypto/src
COPY --from=builder /build/apps/api/dist apps/api/dist
COPY --from=builder /build/apps/web/build apps/web/build

RUN mkdir -p /app/data/files && chown -R appuser:appuser /app/data

USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/secret.db
ENV FILES_PATH=/app/data/files

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
