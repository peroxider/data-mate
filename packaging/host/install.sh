#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# M4 宿主安装(§24 / O01 / O02):介质校验 → releases/<version> → current 软链。
# 客户只执行介质导入、配置和启动;本脚本绝不访问网络、绝不安装依赖(ADR007)。
# 用法: install.sh --media <发行物目录|tar.gz> --prefix <安装根目录> [--systemd]
# ---------------------------------------------------------------------------
set -euo pipefail

usage() {
  echo "用法: install.sh --media <发行物目录|tar.gz> --prefix <安装根目录> [--systemd]" >&2
  exit 2
}

MEDIA=""
PREFIX=""
SYSTEMD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --media) MEDIA="${2:?缺少参数值}"; shift 2 ;;
    --prefix) PREFIX="${2:?缺少参数值}"; shift 2 ;;
    --systemd) SYSTEMD=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$MEDIA" ] && [ -n "$PREFIX" ] || usage

WORK=""
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

case "$MEDIA" in
  *.tar.gz|*.tgz)
    WORK="$(mktemp -d)"
    tar -xzf "$MEDIA" -C "$WORK"
    SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    ;;
  *)
    SRC="$MEDIA"
    ;;
esac

# O01:逐文件校验介质完整性,失败即中止
( cd "$SRC" && sha256sum -c --quiet SHA256SUMS )

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/MANIFEST.json" | head -n1)"
[ -n "$VERSION" ] || { echo "无法从 MANIFEST.json 读取 product.version" >&2; exit 1; }

TARGET="$PREFIX/releases/$VERSION"
echo "介质校验通过,安装版本 $VERSION → $TARGET"

rm -rf "${TARGET}.tmp"
mkdir -p "${TARGET}.tmp"
cp -a "$SRC/." "${TARGET}.tmp/"

# bin 包装器:经 readlink -f 解析软链后定位 app/dist/index.js,
# 使 current 软链切换(升级/回退)对入口透明
mkdir -p "${TARGET}.tmp/bin"
cat > "${TARGET}.tmp/bin/data-analyst" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "$0")"
exec node "$(dirname "$SELF")/../app/dist/index.js" "$@"
EOF
chmod +x "${TARGET}.tmp/bin/data-analyst"

rm -rf "$TARGET"
mv "${TARGET}.tmp" "$TARGET"

mkdir -p "$PREFIX"
if [ -e "$PREFIX/current" ]; then
  readlink "$PREFIX/current" > "$PREFIX/.previous"
fi
ln -sfn "$TARGET" "$PREFIX/current"
mkdir -p "$PREFIX/bin"
ln -sfn "$TARGET/bin/data-analyst" "$PREFIX/bin/data-analyst"

if [ "$SYSTEMD" = "1" ]; then
  UNIT_SRC="$SRC/packaging/host/systemd/data-analyst.service"
  UNIT_DST="/etc/systemd/system/data-analyst.service"
  sed "s|@INSTALL_ROOT@|$PREFIX|g" "$UNIT_SRC" > "$UNIT_DST"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    echo "已写入并加载 $UNIT_DST(启动: systemctl enable --now data-analyst)"
  else
    echo "已写入 $UNIT_DST(未检测到 systemctl,跳过 daemon-reload)"
  fi
fi

echo "安装完成: $PREFIX/current (版本 $VERSION)"
echo "启动示例: $PREFIX/bin/data-analyst serve --config $PREFIX/current/config/config.example.yaml"
echo "环境自检: $PREFIX/bin/data-analyst doctor --config $PREFIX/current/config/config.example.yaml"
