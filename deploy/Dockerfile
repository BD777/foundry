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
RUN pnpm --filter @bd777/foundry-protocol build \
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
RUN pnpm install --frozen-lockfile \
      --filter @bd777/foundry-protocol --filter @bd777/foundry-worker

COPY packages packages
# Pack the two packages exactly as npm publishes them, and list the packages
# the worker installs beside itself (the agent SDKs, node-pty), so the image
# gets the same runtime as `npx @bd777/foundry-worker install`.
RUN pnpm --filter @bd777/foundry-protocol build \
 && pnpm --filter @bd777/foundry-worker build \
 && mkdir /pkgs \
 && pnpm --filter @bd777/foundry-protocol pack --pack-destination /pkgs \
 && pnpm --filter @bd777/foundry-worker pack --pack-destination /pkgs \
 && node --input-type=module -e "\
      import { readFileSync, writeFileSync } from 'node:fs'; \
      import { runtimeCompanions } from '/app/packages/worker/dist/worker-install.js'; \
      const c = runtimeCompanions(JSON.parse(readFileSync('/app/packages/worker/package.json', 'utf8'))); \
      writeFileSync('/pkgs/required', c.required.join(' ')); \
      writeFileSync('/pkgs/best-effort', c.bestEffort.join(' '));"

# The worker's runtime, as `install` builds it: optional packages are left
# out (the SDKs' own copies of Claude Code and Codex), and the SDKs are added
# at the versions the worker pins. node-pty has no Linux prebuild; this stage
# has the compiler it needs, and the final image runs the same Node major.
RUN mkdir -p /opt/worker && cd /opt/worker \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --omit=dev --omit=optional \
      /pkgs/*.tgz $(cat /pkgs/required) \
 && npm install --no-audit --no-fund --omit=dev --omit=optional $(cat /pkgs/best-effort)

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
# The agent programs the worker runs. Foundry never bundles them; the image
# installs them like a person would (npm is an official install method for
# both). Pinned so an image rebuild is reproducible; override to update.
ARG CLAUDE_CODE_VERSION=2.1.289
ARG CODEX_VERSION=0.160.0
ENV npm_config_registry=$NPM_REGISTRY \
    npm_config_maxsockets=$NPM_NETWORK_CONCURRENCY

# git: per-issue worktrees and evidence capture. ca-certificates: HTTPS to
# the provider APIs. openssh-client: cloning private git repositories.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund \
      "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" \
      "@openai/codex@$CODEX_VERSION"

COPY --from=worker-builder /opt/worker /opt/worker
COPY deploy/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/worker-entrypoint.sh \
 && mkdir -p /home/foundry /workspace

ENV HOME=/home/foundry \
    FOUNDRY_WORKSPACE=/workspace/default

ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
