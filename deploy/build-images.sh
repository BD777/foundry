#!/usr/bin/env bash
# Build the server and worker images for another machine and export them as
# one tar.gz for `docker load` on the deployment host.
#
# Run from anywhere:
#   deploy/build-images.sh
# Optional environment:
#   PLATFORM=linux/arm64                target platform (default linux/amd64)
#   TAG=local                           image tag (default local)
#   GOPROXY=... NPM_REGISTRY=...        package mirrors, passed as build args
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM="${PLATFORM:-linux/amd64}"
TAG="${TAG:-local}"
SERVER_IMAGE="foundry-server:$TAG"
WORKER_IMAGE="foundry-worker:$TAG"

cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "error: docker buildx plugin missing" >&2
  exit 1
fi

build_args=()
[ -n "${GOPROXY:-}" ] && build_args+=(--build-arg "GOPROXY=$GOPROXY")
[ -n "${NPM_REGISTRY:-}" ] && build_args+=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
# Serialize npm fetches when emulating another architecture (see Dockerfile).
host_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
if [ "linux/$host_arch" != "$PLATFORM" ]; then
  build_args+=(--build-arg NPM_NETWORK_CONCURRENCY=1)
fi

for target in foundry-server foundry-worker; do
  echo ">> 构建 $target:$TAG ($PLATFORM)"
  docker buildx build \
    --platform "$PLATFORM" \
    --target "$target" \
    -t "$target:$TAG" \
    ${build_args[@]+"${build_args[@]}"} \
    --load \
    -f deploy/Dockerfile \
    .
done

OUT_DIR="$REPO_ROOT/artifacts/images"
OUT_FILE="$OUT_DIR/foundry-images-$TAG-$(date +%Y%m%d-%H%M%S).tar.gz"
mkdir -p "$OUT_DIR"

echo ">> 导出镜像到 $OUT_FILE"
docker save "$SERVER_IMAGE" "$WORKER_IMAGE" | gzip > "$OUT_FILE"

echo ""
echo "完成：$OUT_FILE"
echo "把该文件拷到部署主机后 docker load（见 deploy/README.md）。"
