#!/usr/bin/env bash
# 卸载 ai-qq-bridge，并还原 QQ 入口
set -euo pipefail

PREFIX="/opt/ai-qq-bridge"
DATA="/data"
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help)
      echo "用法: ./uninstall.sh [--prefix DIR] [--data DIR] [--purge]"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

resolve_qq () {
  if [ -n "${QQ_BIN:-}" ] && [ -x "${QQ_BIN}" ]; then echo "$QQ_BIN"; return; fi
  for candidate in /opt/QQ/qq /usr/bin/qq /usr/local/bin/qq; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  command -v qq 2>/dev/null || true
}

QQ_BIN="$(resolve_qq)"
if [ -n "$QQ_BIN" ] && [ -f "$PREFIX/scripts/patch-qq.mjs" ]; then
  APP_DIR="$(dirname "$(readlink -f "$QQ_BIN")")/resources/app"
  echo "[uninstall] 还原 QQ 入口 $APP_DIR"
  if command -v node >/dev/null 2>&1; then
    node "$PREFIX/scripts/patch-qq.mjs" --app-dir "$APP_DIR" --restore || true
  else
    ELECTRON_RUN_AS_NODE=1 "$QQ_BIN" "$PREFIX/scripts/patch-qq.mjs" --app-dir "$APP_DIR" --restore || true
  fi
fi

rm -f /usr/local/bin/aiqq-node /usr/local/bin/aiqq-run /usr/local/bin/aiqq-install-qq /usr/local/bin/aiqq-patch
rm -rf "$PREFIX"

if [ "$PURGE" = "1" ]; then
  echo "[uninstall] 删除数据目录 $DATA"
  rm -rf "$DATA"
else
  echo "[uninstall] 保留数据目录 $DATA（--purge 可删除）"
fi
echo "[uninstall] 完成"
