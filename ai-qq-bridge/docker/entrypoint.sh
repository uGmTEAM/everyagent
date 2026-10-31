#!/usr/bin/env bash
set -u

export DISPLAY="${DISPLAY:-:99}"
export BRIDGE_HOME="${BRIDGE_HOME:-/opt/ai-qq-bridge}"
export BRIDGE_DATA_DIR="${BRIDGE_DATA_DIR:-/data}"
export HOME="${HOME:-/data/home}"

mkdir -p "$BRIDGE_DATA_DIR" "$HOME"

XVFB_PID=""
cleanup () {
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  echo "[entrypoint] 启动 Xvfb $DISPLAY"
  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
  XVFB_PID=$!
  sleep 1
fi

resolve_qq () {
  if [ -n "${QQ_BIN:-}" ] && [ -x "$QQ_BIN" ]; then
    echo "$QQ_BIN"
    return
  fi
  for candidate in /opt/QQ/qq /usr/bin/qq /usr/local/bin/qq; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  command -v qq 2>/dev/null || true
}

QQ_BIN="$(resolve_qq)"
if [ -z "$QQ_BIN" ]; then
  DEB_FILE="${QQ_DEB_FILE:-}"
  if [ -z "$DEB_FILE" ] && [ -f "$BRIDGE_HOME/vendor/qq.deb" ]; then
    DEB_FILE="$BRIDGE_HOME/vendor/qq.deb"
  fi
  if [ -z "$DEB_FILE" ] && [ -f /data/qq.deb ]; then
    DEB_FILE="/data/qq.deb"
  fi
  echo "[entrypoint] 未检测到 QQ，尝试安装（$DEB_FILE）"
  QQ_DEB_FILE="$DEB_FILE" "$BRIDGE_HOME/docker/install-qq.sh" || {
    echo "[entrypoint] QQ 安装失败：请把 deb 放到 /data/qq.deb 后重启，或检查网络"
    sleep 30
    exit 1
  }
  QQ_BIN="$(resolve_qq)"
fi
if [ -z "$QQ_BIN" ]; then
  echo "[entrypoint] 未找到 QQ 可执行文件，请检查镜像或设置 QQ_BIN"
  exit 1
fi

APP_DIR="${BRIDGE_QQ_APP_DIR:-$(dirname "$(readlink -f "$QQ_BIN")")/resources/app}"
echo "[entrypoint] QQ=$QQ_BIN app=$APP_DIR"

run_node () {
  if command -v node >/dev/null 2>&1; then
    node "$@"
  else
    ELECTRON_RUN_AS_NODE=1 "$QQ_BIN" "$@"
  fi
}

run_node "$BRIDGE_HOME/scripts/patch-qq.mjs" --app-dir "$APP_DIR" || exit 1

while true; do
  echo "[entrypoint] 启动 QQ"
  "$QQ_BIN" --no-sandbox --disable-setuid-sandbox --disable-gpu --disable-gpu-compositing --disable-dev-shm-usage &
  pid=$!
  wait "$pid"
  code=$?

  if [ "$code" -eq 75 ]; then
    echo "[entrypoint] 账号切换触发，重新启动 QQ"
    continue
  fi
  if [ "$code" -eq 76 ]; then
    echo "[entrypoint] 无可用备用账号，5 秒后重试"
    sleep 5
    continue
  fi
  if [ "$code" -eq 0 ]; then
    echo "[entrypoint] QQ 正常退出，2 秒后重启"
    sleep 2
    continue
  fi
  echo "[entrypoint] QQ 异常退出 code=$code，5 秒后重启"
  sleep 5
done
