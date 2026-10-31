FROM ubuntu:22.04

ARG QQ_DEB_URL=""
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb x11-utils xauth \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
      libasound2 libxkbcommon0 libgtk-3-0 libxss1 libnotify4 libxtst6 \
      libsecret-1-0 libappindicator3-1 libgl1 libegl1 libxcomposite1 \
      libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
      fonts-noto-cjk procps \
    && rm -rf /var/lib/apt/lists/*

COPY docker/install-qq.sh /tmp/install-qq.sh
RUN chmod +x /tmp/install-qq.sh \
    && (QQ_DEB_URL="${QQ_DEB_URL}" /tmp/install-qq.sh \
        || echo "[build] QQ 安装未完成（网络受限），将在容器首次启动时使用 /data/qq.deb 或重新下载")

COPY . /opt/ai-qq-bridge
RUN chmod +x /opt/ai-qq-bridge/docker/entrypoint.sh /opt/ai-qq-bridge/docker/aiqq-node.sh \
    && ln -sf /opt/ai-qq-bridge/docker/aiqq-node.sh /usr/local/bin/aiqq-node \
    && mkdir -p /data /data/home

ENV BRIDGE_HOME=/opt/ai-qq-bridge \
    BRIDGE_DATA_DIR=/data \
    HOME=/data/home \
    DISPLAY=:99 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    ELECTRON_DISABLE_GPU=1

EXPOSE 3100 3000 3001

ENTRYPOINT ["/opt/ai-qq-bridge/docker/entrypoint.sh"]
