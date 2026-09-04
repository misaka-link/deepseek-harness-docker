# ========================================================
# Dockerfile: deepseek-harness-docker
# Integrated DeepSeek Harness with Chromium Desktop & Unified Gateway
# ========================================================

FROM node:22-bookworm-slim

LABEL maintainer="DeepSeek Harness Community"
LABEL description="Production Docker image for DeepSeek Harness with Container Browser, VNC, and Aesthetic Auth Gateway"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DSH_INSTALL_DIR=/usr/local \
    DSH_WORKSPACE=/workspace \
    PROXY_PORT=3080 \
    DSH_PORT=3079 \
    VNC_PORT=6080 \
    DISPLAY=:99 \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8

# 0. 配置国内 USTC 镜像源加速 (Debian + npm，默认开启；在 GitHub Actions 或海外构建可传 USE_CHINA_MIRROR=0)
ARG USE_CHINA_MIRROR=1
RUN if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
      npm config set registry https://registry.npmmirror.com; \
    fi

# 1. 安装基础依赖、编译工具、X11/VNC 桌面环境、Chromium 与中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    wget \
    git \
    ca-certificates \
    procps \
    locales \
    python3 \
    python-is-python3 \
    build-essential \
    # X11 虚拟显示与桌面
    xvfb \
    x11-utils \
    xdotool \
    scrot \
    openbox \
    x11vnc \
    novnc \
    websockify \
    # 容器 Chromium 浏览器
    chromium \
    # 中文语言与字体支持 (避免网页乱码)
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-noto-color-emoji \
    && echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen zh_CN.UTF-8 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. 全局安装 DeepSeek Harness 官方 CLI 与 pnpm
RUN npm install -g pnpm @deepseek-ai/dsh

# 2.1 按需预装社区插件清单 (默认关闭 PREINSTALL_PLUGINS=0；设为 1 时自动安装 plugins.market.list)
ARG PREINSTALL_PLUGINS=0
COPY plugins.market.list /app/plugins.market.list
RUN if [ "$PREINSTALL_PLUGINS" = "1" ] || [ "$PREINSTALL_PLUGINS" = "true" ]; then \
      echo "===> 正在根据 plugins.market.list 预装社区插件清单 (Market 变体)..." \
      && sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' /app/plugins.market.list \
         | grep -v '^$' \
         | xargs -r npm install -g \
      && for p in dshmarket @hytime/dsh-thinking-effort; do \
           if [ -d "/usr/local/lib/node_modules/$p" ]; then \
             mkdir -p "/usr/local/lib/node_modules/$p/node_modules"; \
             ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai "/usr/local/lib/node_modules/$p/node_modules/@deepseek-ai"; \
           fi; \
         done \
      && echo "===> 社区插件清单预装完成"; \
    else \
      echo "===> 基础镜像模式 (默认不预装第三方插件)"; \
    fi

# 3. 创建必要目录结构
RUN mkdir -p /app/gateway /app/scripts /app/plugins /workspace /root/.dsh /root/.dsh-snapshots /root/.config/chromium

# 4. 复制项目脚本与网关程序
COPY scripts/ /app/scripts/
COPY gateway/ /app/gateway/
COPY plugins/ /app/plugins/

# 5. 安装网关依赖并赋予脚本执行权限
RUN cd /app/gateway && npm install --production \
    && chmod +x /app/scripts/entrypoint.sh /app/scripts/chromium-docker \
    && ln -s /app/scripts/chromium-docker /usr/local/bin/chromium-docker

# 6. 配置工作目录与挂载卷声明
WORKDIR /workspace
VOLUME ["/root/.dsh", "/workspace", "/root/.config/chromium"]

# 7. 暴露统一对外的服务端口
EXPOSE 3080

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
