#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace/.agent /workspace/corpus /tmp_workspace

if [ "${ENABLE_SCREEN:-0}" = "1" ]; then
  mkdir -p /workspace/.agent/screens /workspace/.agent/browser /workspace/.agent/recordings
  export DISPLAY=:99

  # Xvfb 只有软件渲染：WebKit/GTK 默认走 GL/DRI3，窗口会只画标题栏或直接崩溃。
  # 强制软件渲染，保证浏览器窗口能完整显示并被截图。
  export LIBGL_ALWAYS_SOFTWARE=1
  export GALLIUM_DRIVER=llvmpipe
  export GDK_GL=disable
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
  export GTK_A11Y=none

  Xvfb :99 -screen 0 "${SCREEN_WIDTH:-1440}x${SCREEN_HEIGHT:-900}x24" \
    -ac +extension GLX +render -noreset > /var/log/xvfb.log 2>&1 &
  sleep 1

  if command -v startxfce4 >/dev/null 2>&1; then
    eval "$(dbus-launch --sh-syntax)"
    export DBUS_SESSION_BUS_ADDRESS
    startxfce4 > /var/log/xfce.log 2>&1 &
  else
    openbox > /var/log/openbox.log 2>&1 &
  fi
  sleep 2

  xset s off -dpms > /dev/null 2>&1 || true
  xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false \
    > /dev/null 2>&1 || true
  xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled -n -t bool -s false \
    > /dev/null 2>&1 || true

  x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 0.0.0.0 \
    > /var/log/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 \
    > /var/log/novnc.log 2>&1 &

  if command -v epiphany >/dev/null 2>&1; then
    # 常驻守护：浏览器崩溃后 3 秒自动拉起，避免 AI 截图时只看到空桌面
    (
      while true; do
        epiphany about:blank >> /var/log/browser.log 2>&1
        sleep 3
      done
    ) &
  fi

  echo "[entrypoint] virtual screen ready on :99, noVNC on 6080"
fi

if ! pgrep -x ollama >/dev/null 2>&1; then
  ollama serve >/var/log/ollama.log 2>&1 &
fi

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[entrypoint] ollama ready"
cd /workspace
exec node /opt/agent/main.js
