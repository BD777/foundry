# Multi-stage build for the Foundry Docker deployment (linux/amd64 or
# linux/arm64). Build context must be the repository root:
#   docker build -f deploy/Dockerfile --target foundry-server .
#
# Package sources default to the public registries. Override them for
# networks that need mirrors, e.g.
#   --build-arg GOPROXY=https://goproxy.cn,direct
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# NPM_NETWORK_CONCURRENCY=1 works around a libuv epoll assertion under QEMU
# emulation (e.g. building amd64 images on an arm64 Mac).
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_NETWORK_CONCURRENCY=16

# ---------- web ----------
FROM node:22-bookworm AS web-builder
ARG NPM_REGISTRY
ARG NPM_NETWORK_CONCURRENCY

# Browsers sign in with a Foundry account (session cookie). Empty
# VITE_API_BASE_URL makes the browser call same-origin relative paths, so the
# Go server can host API + UI on one port.

ENV npm_config_registry=$NPM_REGISTRY \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    npm_config_network_concurrency=$NPM_NETWORK_CONCURRENCY

RUN corepack enable
WORKDIR /app

# Install against workspace package manifests first for better layer caching.
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/worker/package.json packages/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN printf 'VITE_API_BASE_URL=\n' > apps/web/.env.production
RUN pnpm --filter @foundry/protocol build \
 && pnpm --filter @foundry/web build

# ---------- server ----------
FROM golang:1.24-bookworm AS server-builder
ARG GOPROXY=https://proxy.golang.org,direct
ARG TARGETARCH
ENV GOPROXY=$GOPROXY
WORKDIR /app

COPY apps/server ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} go build -trimpath \
      -o /foundry-server ./cmd/foundry-server

# ---------- worker build ----------
FROM node:22-bookworm AS worker-builder
ARG NPM_REGISTRY
ARG NPM_NETWORK_CONCURRENCY
ENV npm_config_registry=$NPM_REGISTRY \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    npm_config_network_concurrency=$NPM_NETWORK_CONCURRENCY

RUN corepack enable
WORKDIR /app

COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/worker/package.json packages/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages packages
RUN pnpm --filter @foundry/protocol build \
 && pnpm --filter @foundry/worker build
# Self-contained production tree (workspace deps + linux-x64 optional
# native packages such as @openai/codex for the target platform are bundled). --legacy is
# required by pnpm >=10 because this workspace does not inject deps.
RUN pnpm deploy --legacy --filter @foundry/worker --prod /opt/worker

# ---------- final: server ----------
FROM alpine:3.20 AS foundry-server

RUN apk add --no-cache ca-certificates wget
COPY --from=server-builder /foundry-server /app/foundry-server
COPY --from=web-builder /app/apps/web/dist /app/web/dist

ENV FOUNDRY_HOST=0.0.0.0 \
    PORT=31982 \
    FOUNDRY_WEB_DIST=/app/web/dist \
    FOUNDRY_DB_PATH=/data/foundry.db

WORKDIR /app
EXPOSE 31982
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:31982/healthz || exit 1
ENTRYPOINT ["/app/foundry-server"]

# ---------- final: worker ----------
FROM node:22-bookworm-slim AS foundry-worker
ARG NPM_REGISTRY
ARG NPM_NETWORK_CONCURRENCY

# git: per-issue worktrees and evidence capture. ca-certificates: HTTPS to
# the provider APIs. openssh-client: cloning private git repositories.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --registry="$NPM_REGISTRY" --maxsockets="$NPM_NETWORK_CONCURRENCY" \
      @anthropic-ai/claude-code

COPY --from=worker-builder /opt/worker /opt/worker
COPY deploy/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/worker-entrypoint.sh \
 && mkdir -p /home/foundry /workspace

ENV HOME=/home/foundry \
    FOUNDRY_WORKSPACE=/workspace/default

ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
