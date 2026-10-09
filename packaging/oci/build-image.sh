#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# M4 容器镜像构建(§24):以同一发行物 tar.gz 为唯一输入。
# 用法: build-image.sh <包含 data-analyst-*.tar.gz 的目录> [镜像tag]
# 环境变量 BASE_IMAGE 覆盖基础镜像(默认 node:22.19-bookworm-slim,须已在本地)。
# ---------------------------------------------------------------------------
set -euo pipefail

[ $# -ge 1 ] || { echo "用法: build-image.sh <发行物目录> [镜像tag]" >&2; exit 2; }
MEDIA_DIR="$(cd "$1" && pwd)"
TAG="${2:-}"

TARBALL="$(ls "$MEDIA_DIR"/data-analyst-*.tar.gz | head -n1)"
[ -n "$TARBALL" ] || { echo "未找到 data-analyst-*.tar.gz" >&2; exit 1; }
if [ -f "${TARBALL}.sha256" ]; then
  (cd "$(dirname "$TARBALL")" && sha256sum -c --quiet "$(basename "${TARBALL}.sha256")")
fi

VERSION="$(basename "$TARBALL" | sed -n 's/^data-analyst-\(.*\)-[^-]*\.tar\.gz$/\1/p')"
TAG="${TAG:-data-analyst:${VERSION:-local}}"

exec docker build \
  --build-arg "BASE_IMAGE=${BASE_IMAGE:-node:22.19-bookworm-slim}" \
  -f "$(cd "$(dirname "$0")" && pwd)/Dockerfile" \
  -t "$TAG" \
  "$MEDIA_DIR"
