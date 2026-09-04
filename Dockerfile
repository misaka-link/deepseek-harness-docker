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
    LC_ALL=zh_CN.UTF-8 \
    GOROOT=/usr/local/go \
    GOPATH=/go \
    PATH=/usr/local/go/bin:/go/bin:$PATH

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
    openssh-client \
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
    # 字体与 Emoji 完整支持 (避免网页与桌面乱码、提供彩色 Emoji 与符号回退)
    fontconfig \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-noto-color-emoji \
    fonts-symbola \
    # 高性能多线程压缩与归档工具 (7-Zip 与多核并行 gzip 加速)
    p7zip-full \
    pigz \
    && echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen zh_CN.UTF-8 \
    && mkdir -p /etc/fonts \
    && printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <alias>\n    <family>sans-serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>monospace</family>\n    <prefer>\n      <family>WenQuanYi Micro Hei Mono</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>emoji</family>\n    <prefer>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n</fontconfig>\n' > /etc/fonts/local.conf \
    && fc-cache -f \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 1.1 安装 GitHub CLI 官方工具 (gh)
RUN (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
     && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
     && apt-get update && apt-get install -y --no-install-recommends gh) \
    || (ARCH=$(dpkg --print-architecture) \
        && curl -sSL "https://github.com/cli/cli/releases/download/v2.60.1/gh_2.60.1_linux_${ARCH}.tar.gz" -o /tmp/gh.tar.gz \
        && tar -C /tmp -xzf /tmp/gh.tar.gz \
        && mv /tmp/gh_*/bin/gh /usr/local/bin/gh \
        && rm -rf /tmp/gh*) \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && gh --version

# 2. 安装最新官方 Golang 开发环境 (内置国内与海外加速源切换)
ARG GO_VERSION=""
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "${ARCH}" in \
      amd64) GOARCH='amd64' ;; \
      arm64) GOARCH='arm64' ;; \
      armhf) GOARCH='armv6l' ;; \
      i386)  GOARCH='386' ;; \
      *) echo "不支持的架构: ${ARCH}"; exit 1 ;; \
    esac; \
    TARGET_VERSION="${GO_VERSION}"; \
    if [ -z "${TARGET_VERSION}" ]; then \
      if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
        TARGET_VERSION="$(curl -sSL https://golang.google.cn/VERSION?m=text 2>/dev/null | head -n 1 | tr -d '\r\n' || true)"; \
      fi; \
      if [ -z "${TARGET_VERSION}" ]; then \
        TARGET_VERSION="$(curl -sSL https://go.dev/VERSION?m=text 2>/dev/null | head -n 1 | tr -d '\r\n' || echo 'go1.27.1')"; \
      fi; \
    fi; \
    case "${TARGET_VERSION}" in go*) ;; *) TARGET_VERSION="go${TARGET_VERSION}" ;; esac; \
    echo "===> 正在安装最新 Golang 开发环境 (${TARGET_VERSION} for linux/${GOARCH})..."; \
    GO_TARBALL="${TARGET_VERSION}.linux-${GOARCH}.tar.gz"; \
    DOWNLOAD_SUCCESS=0; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      echo "===> 尝试从国内官方镜像源下载 Golang..."; \
      if curl -sSL --fail "https://golang.google.cn/dl/${GO_TARBALL}" -o /tmp/go.tar.gz; then \
        DOWNLOAD_SUCCESS=1; \
      fi; \
    fi; \
    if [ "${DOWNLOAD_SUCCESS}" = "0" ]; then \
      echo "===> 从全球官方源下载 Golang..."; \
      curl -sSL --fail "https://go.dev/dl/${GO_TARBALL}" -o /tmp/go.tar.gz; \
    fi; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm -f /tmp/go.tar.gz; \
    ln -s /usr/local/go/bin/go /usr/local/bin/go; \
    ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt; \
    mkdir -p /go/src /go/bin /go/pkg /workspace; \
    chmod -R 777 /go; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      /usr/local/go/bin/go env -w GOPROXY="https://goproxy.cn,direct"; \
    fi; \
    go version

# 3. 全局安装 DeepSeek Harness 官方 CLI 与 pnpm，并补齐全局依赖链接
RUN npm install -g pnpm @deepseek-ai/dsh \
    && for d in /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*; do \
         pkg_name=$(basename "$d"); \
         if [ "$pkg_name" != "dsh" ] && [ ! -e "/usr/local/lib/node_modules/@deepseek-ai/$pkg_name" ]; then \
           ln -s "$d" "/usr/local/lib/node_modules/@deepseek-ai/$pkg_name"; \
         fi; \
       done

# 3.1 按需预装社区插件清单 (默认关闭 PREINSTALL_PLUGINS=0；设为 1 时自动安装 plugins.market.list)
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

# 4. 创建必要目录结构 (含 Go 工作区与缓存)
RUN mkdir -p /app/gateway /app/scripts /app/plugins /workspace /root/.dsh /root/.dsh-snapshots /root/.config/chromium /go

# 5. 复制项目脚本与网关程序
COPY scripts/ /app/scripts/
COPY gateway/ /app/gateway/
COPY plugins/ /app/plugins/

# 6. 安装网关依赖并赋予脚本执行权限
RUN cd /app/gateway && npm install --production \
    && chmod +x /app/scripts/entrypoint.sh /app/scripts/chromium-docker \
    && ln -s /app/scripts/chromium-docker /usr/local/bin/chromium-docker

# 7. 配置工作目录与挂载卷声明
WORKDIR /workspace
VOLUME ["/root/.dsh", "/workspace", "/root/.config/chromium"]

# 8. 暴露统一对外的服务端口
EXPOSE 3080

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
