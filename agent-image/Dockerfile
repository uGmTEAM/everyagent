FROM ollama/ollama:latest AS ollama-src

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git jq ripgrep unzip zip xz-utils \
    python3 python3-pip python3-venv build-essential poppler-utils \
    libgomp1 procps htop less vim nano file tree \
    iproute2 net-tools iputils-ping dnsutils netcat-openbsd traceroute \
    xvfb x11vnc novnc websockify xdotool scrot imagemagick openbox \
    xfce4 xfce4-terminal dbus-x11 fonts-noto-cjk epiphany-browser x11-xserver-utils \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=24.19.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

RUN pip3 install --break-system-packages --no-cache-dir --ignore-installed \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    numpy pandas requests beautifulsoup4 lxml matplotlib scipy scikit-learn

COPY ollama-bin/ollama /usr/bin/ollama
# 只复制 CPU 推理所需库，避免把 CUDA/ROCm/MLX 等数 GB 的 GPU 运行库打进镜像
RUN --mount=from=ollama-src,source=/usr/lib/ollama,target=/mnt/ollama-lib \
    mkdir -p /usr/lib/ollama \
    && cp -a /mnt/ollama-lib/*.so* /mnt/ollama-lib/llama-server /mnt/ollama-lib/llama-quantize /usr/lib/ollama/
RUN chmod +x /usr/bin/ollama && ollama --version

ENV OLLAMA_HOST=127.0.0.1:11434
ENV OLLAMA_MODELS=/root/.ollama/models

RUN (ollama serve > /tmp/ollama-build.log 2>&1 &) \
    && for i in $(seq 1 60); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done \
    && ollama pull nomic-embed-text \
    && (pkill -x ollama || true) \
    && rm -f /tmp/ollama-build.log

COPY agent /opt/agent
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /workspace

CMD ["/entrypoint.sh"]
