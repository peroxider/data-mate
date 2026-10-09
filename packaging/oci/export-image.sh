#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# M4 镜像导出(§24):docker save 生成离线介质并附 SHA-256。
# 用法: export-image.sh <镜像tag> [输出目录]
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE="${1:?用法: export-image.sh <镜像tag> [输出目录]}"
OUT_DIR="${2:-$(pwd)}"
mkdir -p "$OUT_DIR"

SAFE_NAME="$(echo "$IMAGE" | tr '/:' '__')"
OUTPUT="$OUT_DIR/${SAFE_NAME}.tar"
docker save "$IMAGE" -o "$OUTPUT"
SHA="$(sha256sum "$OUTPUT" | awk '{print $1}')"
printf '%s  %s\n' "$SHA" "$(basename "$OUTPUT")" > "${OUTPUT}.sha256"
echo "镜像已导出: $OUTPUT (sha256: $SHA)"
