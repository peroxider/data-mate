#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# M4 升级回退(§24):将 current 软链指回安装时记录的上一版本。
# install.sh 每次切换 current 前都会把旧指向写入 <prefix>/.previous。
# 用法: rollback.sh --prefix <安装根目录> [--to <版本号>]
# ---------------------------------------------------------------------------
set -euo pipefail

usage() {
  echo "用法: rollback.sh --prefix <安装根目录> [--to <版本号>]" >&2
  exit 2
}

PREFIX=""
TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?缺少参数值}"; shift 2 ;;
    --to) TO="${2:?缺少参数值}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$PREFIX" ] || usage

if [ -z "$TO" ]; then
  if [ ! -f "$PREFIX/.previous" ]; then
    echo "无回退记录($PREFIX/.previous 不存在);可用 --to 显式指定版本" >&2
    exit 1
  fi
  TO="$(cat "$PREFIX/.previous")"
else
  case "$TO" in
    /*) TO="$TO" ;;
    *) TO="$PREFIX/releases/$TO" ;;
  esac
fi

if [ ! -d "$TO" ]; then
  echo "回退目标不存在: $TO" >&2
  exit 1
fi

ln -sfn "$TO" "$PREFIX/current"
echo "已回退: $PREFIX/current → $TO"
"$PREFIX/bin/data-analyst" version --json 2>/dev/null || true
