#!/usr/bin/env bash
# ai-qq-bridge tar.gz 安装脚本（在 Docker 容器内执行）
set -euo pipefail

PREFIX="/opt/ai-qq-bridge"
DATA="/data"
QQ_DEB=""
QQ_URL=""
WITH_DEPS=0
NO_PATCH=0
NO_QQ=0

usage () {
  cat <<'EOF'
用法: ./install.sh [选项]

  --prefix DIR    安装目录，默认 /opt/ai-qq-bridge
  --data DIR      数据目录，默认 /data
  --qq-deb FILE   本地 QQ Linux deb 安装包
  --qq-url URL    从指定 URL 下载 QQ deb
  --with-deps     用 apt-get 安装 Xvfb / Electron 运行库
  --no-qq         不安装 QQ，只安装桥接程序
  --no-patch      不修改 QQ 入口（稍后可运行 aiqq-patch）
  -h, --help      显示帮助

安装完成后：
  aiqq-run                       前台启动 Xvfb + QQ + 桥接服务
  curl 127.0.0.1:3100/health     查看状态
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --qq-deb) QQ_DEB="$2"; shift 2 ;;
    --qq-url) QQ_URL="$2"; shift 2 ;;
    --with-deps) WITH_DEPS=1; shift ;;
    --no-qq) NO_QQ=1; shift ;;
    --no-patch) NO_PATCH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "[install] 需要 root 权限"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$ROOT_DIR/VERSION" 2>/dev/null || echo dev)"
echo "[install] ai-qq-bridge $VERSION -> $PREFIX"

if [ "$WITH_DEPS" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "[install] 安装系统依赖"
    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb x11-utils xauth \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
      libasound2 libxkbcommon0 libgtk-3-0 libxss1 libnotify4 libxtst6 \
      libsecret-1-0 libappindicator3-1 libgl1 libegl1 libxcomposite1 \
      libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
      fonts-noto-cjk procps
  else
    echo "[install] 未找到 apt-get，跳过系统依赖安装"
  fi
fi

mkdir -p "$PREFIX" "$DATA" "$DATA/home"
cp -a "$ROOT_DIR"/. "$PREFIX"/
chmod -R u=rwX,go=rX "$PREFIX"
chmod +x "$PREFIX/install.sh" "$PREFIX/uninstall.sh" "$PREFIX/docker/entrypoint.sh" "$PREFIX/docker/aiqq-node.sh" "$PREFIX/docker/install-qq.sh" 2>/dev/null || true

if [ ! -f "$DATA/config.json" ]; then
  echo "[install] 写入默认配置 $DATA/config.json"
  cat > "$DATA/config.json" <<EOF
{
  "http": { "host": "0.0.0.0", "port": 3100, "token": "" },
  "qq": {
    "account": "",
    "autoLogin": true,
    "switchOnKick": true,
    "dataDir": "$DATA/qq",
    "quickLoginTimeoutMs": 20000,
    "qrTimeoutSec": 180
  },
  "accounts": [],
  "storage": { "dir": "$DATA/messages" },
  "media": {
    "autoDownloadImages": true,
    "imageTimeoutMs": 20000,
    "maxDownloadBytes": 104857600,
    "maxUploadBytes": 209715200
  },
  "backfill": { "enabled": true, "maxPeers": 100, "perPeer": 20 },
  "onebot": {
    "enabled": false,
    "host": "0.0.0.0",
    "port": 3000,
    "token": "",
    "webhook": "",
    "websocket": { "enabled": true, "port": 3001 },
    "reverseWebsocket": ""
  },
  "log": { "level": "info", "buffer": 500 }
}
EOF
fi

resolve_qq () {
  if [ -n "${QQ_BIN:-}" ] && [ -x "${QQ_BIN}" ]; then echo "$QQ_BIN"; return; fi
  for candidate in /opt/QQ/qq /usr/bin/qq /usr/local/bin/qq; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  command -v qq 2>/dev/null || true
}

QQ_BIN="$(resolve_qq)"
if [ -z "$QQ_BIN" ] && [ "$NO_QQ" = "0" ]; then
  local_deb="${QQ_DEB:-}"
  if [ -z "$local_deb" ] && [ -f "$PREFIX/vendor/qq.deb" ]; then
    local_deb="$PREFIX/vendor/qq.deb"
  fi
  if [ -n "$local_deb" ] || [ -n "$QQ_URL" ]; then
    echo "[install] 安装 QQ"
    QQ_DEB_FILE="$local_deb" QQ_DEB_URL="$QQ_URL" bash "$PREFIX/docker/install-qq.sh" || {
      echo "[install] QQ 安装失败，可稍后运行 aiqq-install-qq"
    }
    QQ_BIN="$(resolve_qq)"
  else
    echo "[install] 未提供 QQ 安装包，跳过 QQ 安装"
    echo "          可稍后执行: aiqq-install-qq /path/to/qq.deb"
  fi
fi

if [ -n "$QQ_BIN" ] && [ "$NO_PATCH" = "0" ]; then
  APP_DIR="$(dirname "$(readlink -f "$QQ_BIN")")/resources/app"
  echo "[install] 注入 QQ 入口 $APP_DIR"
  if command -v node >/dev/null 2>&1; then
    node "$PREFIX/scripts/patch-qq.mjs" --app-dir "$APP_DIR" || echo "[install] 入口注入失败"
  else
    ELECTRON_RUN_AS_NODE=1 "$QQ_BIN" "$PREFIX/scripts/patch-qq.mjs" --app-dir "$APP_DIR" || echo "[install] 入口注入失败"
  fi
fi

cat > /usr/local/bin/aiqq-node <<EOF
#!/bin/sh
exec "$PREFIX/docker/aiqq-node.sh" "\$@"
EOF
chmod +x /usr/local/bin/aiqq-node

cat > /usr/local/bin/aiqq-run <<EOF
#!/bin/sh
exec env BRIDGE_HOME="$PREFIX" BRIDGE_DATA_DIR="\${BRIDGE_DATA_DIR:-$DATA}" "$PREFIX/docker/entrypoint.sh" "\$@"
EOF
chmod +x /usr/local/bin/aiqq-run

cat > /usr/local/bin/aiqq-install-qq <<EOF
#!/bin/sh
QQ_DEB_FILE="\${1:-$PREFIX/vendor/qq.deb}" "$PREFIX/docker/install-qq.sh"
EOF
chmod +x /usr/local/bin/aiqq-install-qq

cat > /usr/local/bin/aiqq-patch <<EOF
#!/bin/sh
QQ_BIN="\${QQ_BIN:-\$(command -v qq || echo /opt/QQ/qq)}"
APP_DIR="\$(dirname "\$(readlink -f "\$QQ_BIN")")/resources/app"
if command -v node >/dev/null 2>&1; then
  exec node "$PREFIX/scripts/patch-qq.mjs" --app-dir "\$APP_DIR" "\$@"
fi
exec env ELECTRON_RUN_AS_NODE=1 "\$QQ_BIN" "$PREFIX/scripts/patch-qq.mjs" --app-dir "\$APP_DIR" "\$@"
EOF
chmod +x /usr/local/bin/aiqq-patch

echo ""
echo "[install] 完成"
echo "  数据目录 : $DATA"
echo "  QQ 入口  : $QQ_BIN"
echo "  启动     : aiqq-run"
echo "  状态     : curl 127.0.0.1:3100/health"
echo "  二维码   : curl -s 127.0.0.1:3100/v1/login/qrcode | sed -n 's/.*\"qr_base64\":\"\\([^\"]*\\)\".*/\\1/p' | base64 -d > qrcode.png"
