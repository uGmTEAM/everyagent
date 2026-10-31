#!/usr/bin/env bash
set -euo pipefail

ARCH="$(uname -m)"
CONFIG_URL="https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js"

pick_url () {
  local config="$1"
  local key="$2"
  printf '%s' "$config" \
    | grep -oE "\"${key}\":\\{[^}]+\\}" \
    | grep -oE 'https://[^"]+\.deb' \
    | head -n1
}

if [ -n "${QQ_DEB_FILE:-}" ] && [ -f "${QQ_DEB_FILE}" ]; then
  echo "[install-qq] 使用本地安装包 $QQ_DEB_FILE"
  cp "${QQ_DEB_FILE}" /tmp/qq.deb
  url="local"
elif [ -n "${QQ_DEB_URL:-}" ]; then
  url="$QQ_DEB_URL"
else
  echo "[install-qq] 读取官方 Linux QQ 下载配置..."
  config="$(curl -fsSL --max-time 25 "$CONFIG_URL" || true)"
  if [ -z "$config" ]; then
    echo "[install-qq] 无法读取 $CONFIG_URL"
    exit 1
  fi
  case "$ARCH" in
    aarch64|arm64) url="$(pick_url "$config" armDownloadUrl)" ;;
    *)             url="$(pick_url "$config" x64DownloadUrl)" ;;
  esac
fi

if [ -z "${url:-}" ]; then
  echo "[install-qq] 自动解析失败。请重新构建并传入："
  echo "  docker build --build-arg QQ_DEB_URL=https://qqdl.gtimg.cn/.../QQ_x.y.z_xxxxxx_amd64_01.deb ..."
  echo "  或把 deb 放到 /data/qq.deb 后重启容器"
  exit 1
fi

if [ "$url" != "local" ]; then
  echo "[install-qq] 下载 $url"
  curl -fL --retry 3 --connect-timeout 20 -o /tmp/qq.deb "$url"
fi

apt-get update >/dev/null 2>&1 || true
dpkg -i /tmp/qq.deb || apt-get -f install -y
rm -f /tmp/qq.deb

if [ ! -d /opt/QQ/resources/app ]; then
  echo "[install-qq] 未找到 /opt/QQ/resources/app，安装可能不完整"
  find / -maxdepth 4 -name wrapper.node 2>/dev/null | head -n 5 || true
  exit 1
fi

echo "[install-qq] QQ 安装完成"
