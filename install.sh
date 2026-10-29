#!/usr/bin/env bash
# EveryAgent 安装脚本（Linux）
#
# 用法：
#   bash install.sh                 环境检查 + 安装后端依赖 + 构建镜像
#   bash install.sh --skip-images   不构建 Docker 镜像（镜像已准备好时）
#   bash install.sh --force-images  强制重建两个镜像
#   bash install.sh --systemd       额外安装并启动 systemd 服务（需要 root）
#   bash install.sh --check         只做环境检查，不做任何改动
#   bash install.sh --help
#
# 环境变量可与后端 config.js 对应：
#   EA_PORT=7842       AI 代理端口（容器经出网代理访问）
#   EA_PANEL_PORT=7843 面板端口
#   EA_BIND / EA_PANEL_BIND  监听地址（默认 0.0.0.0）
#   DOCKER_SOCKET     Docker socket（Linux 默认 /var/run/docker.sock）
#
# 发行包解压后通常没有执行权限，直接使用 bash install.sh 即可。

set -euo pipefail

APP_NAME="everyagent"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
LOG_DIR="$ROOT/data/logs"

SKIP_IMAGES=0
FORCE_IMAGES=0
WITH_SYSTEMD=0
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --skip-images) SKIP_IMAGES=1 ;;
    --force-images) FORCE_IMAGES=1 ;;
    --systemd) WITH_SYSTEMD=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'; C_END=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_BOLD=''; C_END=''
fi

ok()   { echo "${C_OK}[ OK ]${C_END} $*"; }
warn() { echo "${C_WARN}[WARN]${C_END} $*"; }
fail() { echo "${C_ERR}[FAIL]${C_END} $*" >&2; }
step() { echo; echo "${C_BOLD}== $* ==${C_END}"; }

ERRORS=0
fail_item() { fail "$*"; ERRORS=$((ERRORS + 1)); }

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltn "sport = :$port" 2>/dev/null | tail -n +2)" ]
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
  fi
}

step "检查安装目录"
for item in backend/src/server.js agent-image/Dockerfile egress-proxy/Dockerfile memory-service/index.js; do
  if [ -e "$ROOT/$item" ]; then
    ok "$item"
  else
    fail_item "缺少 $item（请在发行包根目录运行本脚本）"
  fi
done
if [ -f "$ROOT/agent-image/ollama-bin/ollama" ]; then
  ok "agent-image/ollama-bin/ollama"
else
  fail_item "缺少 agent-image/ollama-bin/ollama（构建 ea-agent 镜像必需）"
fi

step "检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail_item "未安装 Node.js。需要 Node.js 22.5+（推荐 24 LTS），见 https://nodejs.org/"
else
  NODE_VERSION="$(node -p 'process.versions.node')"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; }; then
    ok "node $NODE_VERSION"
  else
    fail_item "node 版本过低：$NODE_VERSION，需要 22.5+（推荐 24 LTS）"
  fi
  if [ "$NODE_MAJOR" -lt 24 ]; then
    warn "推荐 Node.js 24 LTS，当前 $NODE_VERSION"
  fi
fi
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version)"
else
  fail_item "未安装 npm（通常随 Node.js 一起安装）"
fi
if command -v curl >/dev/null 2>&1; then
  ok "curl"
else
  warn "未安装 curl：安装脚本跳过「后端就绪」检查，可自行用浏览器验证面板"
fi

step "检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  fail_item "未安装 Docker Engine 24+，见 https://docs.docker.com/engine/install/"
else
  ok "docker $(docker --version | sed 's/^Docker version //;s/,.*//')"
  if ! DOCKER_TYPE="$(docker info --format '{{.OSType}}' 2>/dev/null)"; then
    fail_item "无法连接 Docker：请确认 dockerd 已启动，且当前用户在 docker 组（sudo usermod -aG docker \$USER 后重新登录）"
  elif [ "$DOCKER_TYPE" != "linux" ]; then
    fail_item "Docker 不是 Linux 容器模式（当前 OSType=$DOCKER_TYPE）"
  else
    ok "Docker 守护进程可用（Linux 容器）"
  fi
fi

step "检查磁盘与内存"
FREE_GB="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {printf "%.1f", $4/1048576}')"
TOTAL_DISK_GB="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {printf "%.1f", $2/1048576}')"
if [ -z "$FREE_GB" ]; then
  warn "无法读取磁盘剩余空间"
elif awk "BEGIN{exit !($FREE_GB >= 10)}"; then
  ok "安装盘剩余 ${FREE_GB}G / ${TOTAL_DISK_GB}G"
else
  fail_item "安装盘剩余 ${FREE_GB}G，建议至少 10G（镜像约 4G，各 AI 工作区另计）"
fi
MEM_GB="$(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null || true)"
if [ -n "$MEM_GB" ]; then
  if awk "BEGIN{exit !($MEM_GB >= 8)}"; then
    ok "内存 ${MEM_GB}G"
  else
    warn "内存 ${MEM_GB}G 偏小：每个 AI 容器默认 4G（开虚拟屏 6G），建议 16G 以上"
  fi
fi

step "检查端口"
for port in 7842 7843; do
  if port_in_use "$port"; then
    warn "端口 $port 已被占用，后端可能无法启动（若这是旧实例可先停止）"
  else
    ok "端口 $port 空闲"
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo
  fail "环境检查未通过（$ERRORS 项），请先解决上面的问题再安装。"
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  ok "环境检查完成（--check 模式，未做任何改动）"
  exit 0
fi

step "安装后端依赖"
cd "$BACKEND_DIR"
if npm install --omit=dev --no-audit --no-fund; then
  ok "backend/node_modules 已就绪"
else
  fail "npm install 失败，请检查网络或 npm 源配置"
  exit 1
fi

if [ "$SKIP_IMAGES" -eq 0 ]; then
  step "构建 Docker 镜像（首次约需数 GB 下载，耗时较长）"

  if [ "$FORCE_IMAGES" -eq 0 ] && docker image inspect ea-egress:latest >/dev/null 2>&1; then
    ok "ea-egress:latest 已存在（跳过；用 --force-images 强制重建）"
  else
    echo "构建 ea-egress:latest ..."
    if docker build -t ea-egress:latest "$ROOT/egress-proxy"; then
      ok "ea-egress:latest"
    else
      fail "ea-egress 构建失败"
      exit 1
    fi
  fi

  if [ "$FORCE_IMAGES" -eq 0 ] && docker image inspect ea-agent:latest >/dev/null 2>&1; then
    ok "ea-agent:latest 已存在（跳过；用 --force-images 强制重建）"
  else
    echo "构建 ea-agent:latest（需要联网下载 Node、apt 包与 ollama 模型）..."
    if docker build -t ea-agent:latest "$ROOT/agent-image"; then
      ok "ea-agent:latest"
    else
      fail "ea-agent 构建失败。常见原因：网络不稳定、Docker 磁盘不足；可重试或配置镜像加速后重试。"
      exit 1
    fi
  fi
else
  step "跳过镜像构建"
  for image in ea-agent:latest ea-egress:latest; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      ok "$image"
    else
      fail_item "镜像 $image 不存在（去掉 --skip-images 重新运行，或先构建）"
    fi
  done
  if [ "$ERRORS" -gt 0 ]; then
    exit 1
  fi
fi

step "准备数据目录"
mkdir -p "$ROOT/data"
ok "$ROOT/data"

if [ "$WITH_SYSTEMD" -eq 1 ]; then
  step "安装 systemd 服务"
  if [ "$(id -u)" -ne 0 ]; then
    fail "--systemd 需要 root：sudo ./install.sh --systemd"
    exit 1
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "当前系统没有 systemd，请手动启动：cd $BACKEND_DIR && node src/server.js"
    exit 1
  fi

  RUN_USER="${SUDO_USER:-root}"
  if [ "$RUN_USER" != "root" ] && ! id -nG "$RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    warn "用户 $RUN_USER 不在 docker 组，服务改以 root 运行（也可把该用户加入 docker 组后改 User=）"
    RUN_USER="root"
  fi

  NODE_BIN="$(command -v node)"
  cat > /etc/systemd/system/$APP_NAME.service <<EOF
[Unit]
Description=EveryAgent AI Research Platform
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$BACKEND_DIR
ExecStart=$NODE_BIN $BACKEND_DIR/src/server.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$APP_NAME"
  ok "systemd 服务已安装并启动：systemctl status $APP_NAME"

  if command -v curl >/dev/null 2>&1; then
    echo "等待后端就绪 ..."
    READY=0
    for _ in $(seq 1 30); do
      if curl -fsS "http://127.0.0.1:7842/health" >/dev/null 2>&1; then
        READY=1
        break
      fi
      sleep 1
    done
    if [ "$READY" -eq 1 ]; then
      ok "后端已就绪"
    else
      warn "后端 30 秒内未就绪，查看日志：journalctl -u $APP_NAME -n 100 --no-pager"
    fi
  fi
else
  step "启动方式"
  echo "  cd $BACKEND_DIR && node src/server.js"
  echo "  或安装为系统服务：sudo bash install.sh --systemd --skip-images"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
step "安装完成"
echo "  面板（管理后台）： http://127.0.0.1:${EA_PANEL_PORT:-7843}"
if [ -n "${LAN_IP:-}" ]; then
  echo "  局域网访问：       http://$LAN_IP:${EA_PANEL_PORT:-7843}"
fi
echo "  AI 代理/接口：     http://127.0.0.1:${EA_PORT:-7842}  （端口 7842 需要开放给容器出网代理）"
echo "  数据目录：         $ROOT/data"
echo "  日志目录：         $LOG_DIR"
echo
echo "下一步："
echo "  1. 打开面板 → 供应商，填写 OpenAI 兼容接口（如 DeepSeek https://api.deepseek.com）与 API Key。"
echo "  2. 在「Judge / 模型」里选择判定模型。"
echo "  3. 新建 AI：填写研究目标、人格（可选）、平台规则。"
echo
warn "面板与 7842 端口默认监听 0.0.0.0 且无鉴权：不要直接暴露到公网，请用防火墙或带认证的反向代理。"
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  warn "SELinux 处于 Enforcing：若 AI 容器无法读写工作区，请给挂载路径加 :z 或调整策略。"
fi
