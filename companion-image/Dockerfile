# 陪伴模式镜像：ea-agent（研究运行时 + 虚拟屏/桌面/noVNC）+ QQ NT + ai-qq-bridge
# 构建时先在仓库根目录执行：
#   docker build -f companion-image/Dockerfile -t ea-companion:latest .
# 注意：ai-qq-bridge/ 是独立仓库（https://github.com/uGmTEAM/ai-qq-bridge），
# 不在本仓库追踪；缺失时 tools/build-companion-image.ps1 会自动 clone 到仓库根目录。
ARG BASE_IMAGE=ea-agent:latest
# QQ 安装包来源：默认从公开镜像取出已安装的 /opt/QQ（腾讯 CDN 在本机 403）
ARG QQ_SOURCE_IMAGE=docker.m.daocloud.io/mlikiowa/napcat-docker:latest
FROM ${QQ_SOURCE_IMAGE} AS qq-src
FROM ${BASE_IMAGE}

ARG QQ_DEB_URL=""
ENV DEBIAN_FRONTEND=noninteractive

# QQ NT（Electron）依赖。ubuntu 24.04 部分包名与 22.04 不同，可选项失败不阻断构建。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
      libxkbcommon0 libxss1 libnotify4 libxtst6 libsecret-1-0 \
      libgl1 libegl1 libxcomposite1 libxdamage1 libxrandr2 \
      libpango-1.0-0 libcairo2 x11-utils xauth \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update \
    && (apt-get install -y --no-install-recommends libasound2t64 || apt-get install -y --no-install-recommends libasound2 || true) \
    && (apt-get install -y --no-install-recommends libayatana-appindicator3-1 || apt-get install -y --no-install-recommends libappindicator3-1 || true) \
    && rm -rf /var/lib/apt/lists/*

COPY ai-qq-bridge /opt/ai-qq-bridge
# 从公开镜像拷入已安装的 QQ NT（版本 3.2.34）。NapCat 的 loadNapCat.js 会被接入脚本覆盖掉。
COPY --from=qq-src /opt/QQ /opt/QQ
RUN rm -f /opt/QQ/resources/app/loadNapCat.js \
    && chmod +x /opt/QQ/qq /opt/ai-qq-bridge/docker/entrypoint.sh /opt/ai-qq-bridge/docker/aiqq-node.sh \
    && ln -sf /opt/ai-qq-bridge/docker/aiqq-node.sh /usr/local/bin/aiqq-node \
    && mkdir -p /data /data/home

# 尽量在构建期装好 QQ；失败则运行时从 /data/qq.deb 或官方地址重试
RUN chmod +x /opt/ai-qq-bridge/docker/install-qq.sh \
    && (QQ_DEB_URL="${QQ_DEB_URL}" /opt/ai-qq-bridge/docker/install-qq.sh \
        || echo "[build] QQ 未在构建期安装，将在容器启动时重试")

COPY agent-image/agent /opt/agent

COPY companion-image/entrypoint.sh /companion-entrypoint.sh
RUN sed -i 's/\r$//' /companion-entrypoint.sh && chmod +x /companion-entrypoint.sh

ENV EA_MODE=companion \
    BRIDGE_HOME=/opt/ai-qq-bridge \
    BRIDGE_DATA_DIR=/data \
    DISPLAY=:99 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    ELECTRON_DISABLE_GPU=1

EXPOSE 3100 6080

WORKDIR /workspace

CMD ["/companion-entrypoint.sh"]
