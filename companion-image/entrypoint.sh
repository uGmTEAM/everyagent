#!/usr/bin/env bash
set -u

export DISPLAY="${DISPLAY:-:99}"
export BRIDGE_HOME="${BRIDGE_HOME:-/opt/ai-qq-bridge}"
export BRIDGE_DATA_DIR="${BRIDGE_DATA_DIR:-/data}"

mkdir -p /workspace/.agent /workspace/corpus /tmp_workspace
mkdir -p /workspace/.agent/screens /workspace/.agent/browser /workspace/.agent/recordings
mkdir -p "$BRIDGE_DATA_DIR" "$BRIDGE_DATA_DIR/home"

export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export GDK_GL=disable
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export GTK_A11Y=none

log () { echo "[companion] $*"; }

# ---------- 虚拟屏 + 桌面 + noVNC ----------
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  log "启动 Xvfb $DISPLAY"
  Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH:-1440}x${SCREEN_HEIGHT:-900}x24" \
    -ac +extension GLX +render -noreset > /var/log/xvfb.log 2>&1 &
  sleep 1
fi

if command -v startxfce4 >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
  startxfce4 > /var/log/xfce.log 2>&1 &
else
  openbox > /var/log/openbox.log 2>&1 &
fi
sleep 2

xset s off -dpms > /dev/null 2>&1 || true
xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false > /dev/null 2>&1 || true
xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled -n -t bool -s false > /dev/null 2>&1 || true

x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -listen 0.0.0.0 \
  > /var/log/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 \
  > /var/log/novnc.log 2>&1 &

log "虚拟屏就绪：$DISPLAY，noVNC 6080"

# ---------- 本地 Ollama（记忆/知识库向量） ----------
if command -v ollama >/dev/null 2>&1; then
  if ! pgrep -x ollama >/dev/null 2>&1; then
    ollama serve > /var/log/ollama.log 2>&1 &
  fi
  for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi

# ---------- QQ 守护进程：QQ/桥退出后自动拉起，退出码 75 自动切换账号 ----------
bridge_supervisor () {
  while true; do
    log "启动 QQ 通讯桥"
    HOME="$BRIDGE_DATA_DIR/home" \
    DISPLAY="$DISPLAY" \
    BRIDGE_HOME="$BRIDGE_HOME" \
    BRIDGE_DATA_DIR="$BRIDGE_DATA_DIR" \
      "$BRIDGE_HOME/docker/entrypoint.sh" >> /var/log/qq-bridge.log 2>&1
    code=$?
    log "QQ/桥退出 code=$code，5 秒后重启"
    sleep 5
  done
}
bridge_supervisor &
BRIDGE_SUP_PID=$!

# ---------- 关闭清理：AI 退出时连带关闭 QQ 与虚拟屏 ----------
shutdown () {
  log "AI 退出，关闭 QQ 与虚拟屏"
  kill "$BRIDGE_SUP_PID" 2>/dev/null || true
  pkill -f "ai-qq-bridge/docker/entrypoint.sh" 2>/dev/null || true
  pkill -f "/opt/QQ/qq" 2>/dev/null || pkill -f QQ 2>/dev/null || true
  pkill -f websockify 2>/dev/null || true
  pkill -x x11vnc 2>/dev/null || true
  pkill -x Xvfb 2>/dev/null || true
}
trap 'shutdown; exit 0' TERM INT

# ---------- AI 运行时（前台）。它退出即容器退出，supervisor 决定是否重启 ----------
cd /workspace
node /opt/agent/main.js
AGENT_CODE=$?
shutdown
exit "$AGENT_CODE"
