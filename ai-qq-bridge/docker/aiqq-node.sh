#!/bin/sh
# 用 QQ 自带 Electron 的 Node 运行时执行脚本，容器内无需另装 node
set -e
if [ -n "${QQ_BIN:-}" ] && [ -x "$QQ_BIN" ]; then
  bin="$QQ_BIN"
elif [ -x /opt/QQ/qq ]; then
  bin=/opt/QQ/qq
else
  bin="$(command -v qq)"
fi
exec env ELECTRON_RUN_AS_NODE=1 "$bin" "$@"
