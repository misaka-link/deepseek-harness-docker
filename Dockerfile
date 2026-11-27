# ========================================================
# Dockerfile: deepseek-harness-docker
# Integrated DeepSeek Harness with Container Browser, VNC & Unified Gateway
# Multi-stage build supporting standard, market, full, and mini variants
# ========================================================

ARG NODE_IMAGE=node:24.22.3-trixie-slim

# ========================================================
# Stage 1: builder —— 负责安装 DSH 核心、pnpm、编译原生模块与预装插件
# ========================================================
FROM ${NODE_IMAGE} AS builder

# 0. 配置国内 HTTPS 镜像源加速与多源自动回退 (Aliyun -> TUNA -> Tencent -> HuaweiCloud -> USTC -> Debian 官方; npm: npmmirror -> npmjs)
ARG USE_CHINA_MIRROR=1
RUN printf 'Acquire::Retries "3";\nAcquire::http::Timeout "12";\nAcquire::https::Timeout "12";\n' > /etc/apt/apt.conf.d/80-retries \
    && if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      npm config set registry https://registry.npmmirror.com; \
    fi
RUN cat > /usr/local/sbin/dsh-apt-install <<'APT_HELPER'
#!/bin/sh
set -eu
if [ "${USE_CHINA_MIRROR:-1}" = "1" ] || [ "${USE_CHINA_MIRROR:-1}" = "true" ]; then
  MIRRORS="mirrors.aliyun.com mirrors.tuna.tsinghua.edu.cn mirrors.tencent.com mirrors.huaweicloud.com mirrors.ustc.edu.cn deb.debian.org"
else
  MIRRORS="deb.debian.org mirrors.aliyun.com"
fi
for m in $MIRRORS; do
  for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do
    [ -f "$f" ] || continue
    sed -i -E "s#https?://(deb\.debian\.org|mirrors\.[a-z0-9.-]+)#https://${m}#g" "$f"
  done
  TLS_BOOT=""
  if [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then
    # slim 底座首次尚未具备根证书包，先借由 Debian 内置 PGP 公钥校验安全引导安装 ca-certificates
    TLS_BOOT="-o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false"
  fi
  if apt-get update -o APT::Update::Error-Mode=any $TLS_BOOT; then
    if [ -n "$TLS_BOOT" ]; then
      apt-get install -y --no-install-recommends $TLS_BOOT ca-certificates || true
    fi
    TLS_RUN=""
    [ -f /etc/ssl/certs/ca-certificates.crt ] || TLS_RUN="$TLS_BOOT"
    if apt-get install -y --no-install-recommends $TLS_RUN "$@"; then
      apt-get clean
      rm -rf /var/lib/apt/lists/*
      exit 0
    fi
  fi
  echo "===> [apt] 镜像源 https://${m} 拉取失败，切换备用源重试..." >&2
  rm -rf /var/lib/apt/lists/*
  sleep 1
done
echo "错误: 所有候选 APT 镜像源 (${MIRRORS}) 均安装失败" >&2
exit 1
APT_HELPER
RUN chmod 0755 /usr/local/sbin/dsh-apt-install

# builder 编译所需最小工具链 (build-essential/python3 用于 node-pty 原生编译)
RUN USE_CHINA_MIRROR="${USE_CHINA_MIRROR}" /usr/local/sbin/dsh-apt-install \
      build-essential \
      python3 \
      python-is-python3 \
      ca-certificates \
      curl

# 全局安装 DeepSeek Harness 官方 CLI 与 pnpm (固定版本 + 校验完整性 + 安装期不执行包脚本)
ARG DSH_VERSION="0.2.3-alpha.2"
ARG PNPM_VERSION="12.5.1"
ARG DSH_INTEGRITY="sha512-mi5hq96nk5x6HPU6gkcHSUZEKs0/xoyd8MV7GCTDpULYlcJVIUkfn5JiNv+UAMaV22VO4VQwbLWnjkFBV5b/ig=="
RUN set -eux; \
    TARGET_PKG="@deepseek-ai/dsh@${DSH_VERSION}"; \
    echo "===> [builder] 正在安装 DeepSeek Harness 官方核心: ${TARGET_PKG} (pnpm@${PNPM_VERSION})..."; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      PRIMARY_REG="https://registry.npmmirror.com"; ALT_REG="https://registry.npmjs.org"; \
    else \
      PRIMARY_REG="https://registry.npmjs.org"; ALT_REG="https://registry.npmmirror.com"; \
    fi; \
    echo "===> 主源 ${PRIMARY_REG}；备用源 ${ALT_REG}"; \
    mkdir -p /tmp/dsh-pkg; \
    INTEG="${DSH_INTEGRITY}"; \
    if [ -z "${INTEG}" ]; then \
      INTEG="$(npm view "${TARGET_PKG}" dist.integrity --registry="${PRIMARY_REG}" 2>/dev/null || npm view "${TARGET_PKG}" dist.integrity --registry="${ALT_REG}" 2>/dev/null || true)"; \
    fi; \
    TGZ="$(npm pack "${TARGET_PKG}" --registry="${PRIMARY_REG}" --pack-destination /tmp/dsh-pkg --silent 2>/dev/null | tail -n 1)"; \
    if [ -z "${TGZ}" ] || [ ! -f "/tmp/dsh-pkg/${TGZ}" ]; then \
      echo "===> 主源未同步 ${TARGET_PKG}，回退备用源拉取 tarball..."; \
      TGZ="$(npm pack "${TARGET_PKG}" --registry="${ALT_REG}" --pack-destination /tmp/dsh-pkg --silent | tail -n 1)"; \
    fi; \
    if [ -n "${INTEG}" ]; then \
      node -e "const c=require('crypto'),f=require('fs');const [alg,b64]=String(process.argv[1]).split('-');const h=c.createHash(alg).update(f.readFileSync(process.argv[2])).digest('base64');if(h!==b64){console.error('integrity 校验失败:',process.argv[1]);process.exit(1)}console.log('integrity OK ('+alg+')');" "${INTEG}" "/tmp/dsh-pkg/${TGZ}"; \
    else \
      echo "警告: registry 未返回 dist.integrity，跳过完整性校验"; \
    fi; \
    npm config set allow-scripts false --location=global 2>/dev/null || true; \
    INSTALL_OK=0; \
    for REG in "${PRIMARY_REG}" "${ALT_REG}"; do \
      if npm install -g --ignore-scripts --registry="${REG}" --prefer-online --fetch-retries=5 --fetch-retry-maxtimeout=60000 "pnpm@${PNPM_VERSION}" "/tmp/dsh-pkg/${TGZ}"; then INSTALL_OK=1; break; fi; \
      echo "===> 依赖解析失败（镜像源未同步齐同批子包或上游元数据竞态），换源重试..."; \
    done; \
    if [ "${INSTALL_OK}" != "1" ]; then echo "错误: DSH 依赖解析在主源与备用源上均失败" >&2; exit 1; fi; \
    rm -rf /tmp/dsh-pkg; \
    (cd /usr/local/lib/node_modules/@deepseek-ai/dsh && npm rebuild node-pty --foreground-scripts) 2>/dev/null || true; \
    for d in /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*; do \
      pkg_name=$(basename "$d"); \
      if [ "$pkg_name" != "dsh" ] && [ ! -e "/usr/local/lib/node_modules/@deepseek-ai/$pkg_name" ]; then \
        ln -s "$d" "/usr/local/lib/node_modules/@deepseek-ai/$pkg_name"; \
      fi; \
    done; \
    find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true; \
    find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true; \
    npm cache clean --force && rm -rf /root/.npm /root/.cache/node-gyp /tmp/*

# 按需预装社区插件清单 (Market 变体)
ARG PREINSTALL_PLUGINS=0
ARG MARKET_REFRESH=""
COPY plugins.market.list /app/plugins.market.list
RUN if [ "$PREINSTALL_PLUGINS" = "1" ] || [ "$PREINSTALL_PLUGINS" = "true" ]; then \
      echo "===> [builder] 正在根据 plugins.market.list 预装社区插件清单 (Market 变体, refresh=${MARKET_REFRESH:-none})..." \
      && sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' /app/plugins.market.list \
         | grep -v '^$' \
         | xargs -r npm install -g --ignore-scripts \
      && for p in dshmarket @hytime/dsh-thinking-effort; do \
           if [ -d "/usr/local/lib/node_modules/$p" ]; then \
             mkdir -p "/usr/local/lib/node_modules/$p/node_modules"; \
             ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai "/usr/local/lib/node_modules/$p/node_modules/@deepseek-ai"; \
           fi; \
         done \
      && npm cache clean --force \
      && rm -rf /root/.npm /root/.cache/node-gyp /tmp/* \
      && echo "===> 社区插件清单预装完成"; \
    else \
      echo "===> [builder] 基础镜像模式 (默认不预装第三方插件)"; \
    fi

# 将非 @deepseek-ai 全局包移至临时目录，以便 runtime 阶段对 @deepseek-ai 单层执行 COPY --chown=1001:1001
RUN set -eux; \
    mkdir -p /tmp/nm-other; \
    for item in /usr/local/lib/node_modules/*; do \
      [ -e "$item" ] || continue; \
      base="$(basename "$item")"; \
      case "$base" in \
        @deepseek-ai|npm|corepack) ;; \
        *) mv "$item" "/tmp/nm-other/$base" ;; \
      esac; \
    done

# ========================================================
# Stage 2: runtime —— 最终运行镜像 (Issue #11 C 档支持)
# ========================================================
FROM ${NODE_IMAGE} AS runtime

# 变体契约：standard | market | full | mini（默认 standard：slim 底座 + 桌面/Chromium + gh，不含 Go 与市场插件）
ARG VARIANT=standard
ARG INSTALL_DESKTOP=1
ARG INSTALL_GO=0
ARG PRUNE_LEVEL=full
# 【Issue #19】套件工程版本：由 build.sh 以 --build-arg SUITE_VERSION="${PROJ_VER}" 注入，
# 落为 ENV DSH_SUITE_VERSION，作为「本镜像由哪次构建产出」的权威来源。
# 取值链见 gateway/src/core/project-version.js。
ARG SUITE_VERSION=""

LABEL maintainer="DeepSeek Harness Community"
LABEL description="Production Docker image for DeepSeek Harness with Container Browser, VNC, and Aesthetic Auth Gateway"
LABEL org.opencontainers.image.variant="${VARIANT}"

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_VARIANT=${VARIANT} \
    DSH_INSTALL_GO=${INSTALL_GO} \
    DSH_SUITE_VERSION=${SUITE_VERSION} \
    DSH_INSTALL_DIR=/usr/local \
    DSH_WORKSPACE=/workspace \
    PROXY_PORT=3080 \
    DSH_PORT=3079 \
    VNC_PORT=6080 \
    NOVNC_ASSET_REVISION=1.6.0 \
    DISPLAY=:99 \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# 0. 配置国内 HTTPS 镜像源加速与多源自动回退 (Aliyun -> TUNA -> Tencent -> HuaweiCloud -> USTC -> Debian 官方; npm: npmmirror -> npmjs)
ARG USE_CHINA_MIRROR=1
RUN printf 'Acquire::Retries "3";\nAcquire::http::Timeout "12";\nAcquire::https::Timeout "12";\n' > /etc/apt/apt.conf.d/80-retries \
    && if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      npm config set registry https://registry.npmmirror.com; \
    fi
RUN cat > /usr/local/sbin/dsh-apt-install <<'APT_HELPER'
#!/bin/sh
set -eu
if [ "${USE_CHINA_MIRROR:-1}" = "1" ] || [ "${USE_CHINA_MIRROR:-1}" = "true" ]; then
  MIRRORS="mirrors.aliyun.com mirrors.tuna.tsinghua.edu.cn mirrors.tencent.com mirrors.huaweicloud.com mirrors.ustc.edu.cn deb.debian.org"
else
  MIRRORS="deb.debian.org mirrors.aliyun.com"
fi
for m in $MIRRORS; do
  for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do
    [ -f "$f" ] || continue
    sed -i -E "s#https?://(deb\.debian\.org|mirrors\.[a-z0-9.-]+)#https://${m}#g" "$f"
  done
  TLS_BOOT=""
  if [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then
    # slim 底座首次尚未具备根证书包，先借由 Debian 内置 PGP 公钥校验安全引导安装 ca-certificates
    TLS_BOOT="-o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false"
  fi
  if apt-get update -o APT::Update::Error-Mode=any $TLS_BOOT; then
    if [ -n "$TLS_BOOT" ]; then
      apt-get install -y --no-install-recommends $TLS_BOOT ca-certificates || true
    fi
    TLS_RUN=""
    [ -f /etc/ssl/certs/ca-certificates.crt ] || TLS_RUN="$TLS_BOOT"
    if apt-get install -y --no-install-recommends $TLS_RUN "$@"; then
      apt-get clean
      rm -rf /var/lib/apt/lists/*
      exit 0
    fi
  fi
  echo "===> [apt] 镜像源 https://${m} 拉取失败，切换备用源重试..." >&2
  rm -rf /var/lib/apt/lists/*
  sleep 1
done
echo "错误: 所有候选 APT 镜像源 (${MIRRORS}) 均安装失败" >&2
exit 1
APT_HELPER
RUN chmod 0755 /usr/local/sbin/dsh-apt-install

# 1. 安装基础依赖与实用 CLI 研发工具 (A 层：同底座共享缓存，不包含变体 ARG)
RUN set -eux; \
    USE_CHINA_MIRROR="${USE_CHINA_MIRROR}" /usr/local/sbin/dsh-apt-install \
      bash \
      curl \
      wget \
      git \
      openssh-client \
      ca-certificates \
      procps \
      psmisc \
      iproute2 \
      locales \
      python3 \
      python-is-python3 \
      file \
      jq \
      less \
      ripgrep \
      rsync \
      zip \
      unzip \
      p7zip-full \
      pigz \
      xz-utils \
      bzip2 \
      tzdata; \
    echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen; \
    locale-gen zh_CN.UTF-8

# 1.1 安装 GitHub CLI 官方工具 (gh；【Issue #11】mini 变体跳过)
RUN set -eux; \
    if [ "${VARIANT}" = "mini" ]; then \
      echo "===> mini 变体：跳过 GitHub CLI (gh) 安装"; \
    else \
      (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
       && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
       && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
       && apt-get update && apt-get install -y --no-install-recommends gh) \
      || (ARCH=$(dpkg --print-architecture) \
          && curl -sSL "https://github.com/cli/cli/releases/download/v2.60.1/gh_2.60.1_linux_${ARCH}.tar.gz" -o /tmp/gh.tar.gz \
          && tar -C /tmp -xzf /tmp/gh.tar.gz \
          && mv /tmp/gh_*/bin/gh /usr/local/bin/gh \
          && rm -rf /tmp/gh*); \
      rm -f /etc/apt/sources.list.d/github-cli.list; \
      apt-get clean && rm -rf /var/lib/apt/lists/* \
      && gh --version; \
    fi

# 1.2 X11/VNC 桌面环境、Chromium 与字体 (B 层：mini 变体跳过桌面与浏览器，仅安装中文字体)
RUN set -eux; \
    if [ "$INSTALL_DESKTOP" = "1" ]; then \
      USE_CHINA_MIRROR="${USE_CHINA_MIRROR}" /usr/local/sbin/dsh-apt-install \
        xvfb \
        x11-utils \
        xdotool \
        scrot \
        openbox \
        x11vnc \
        novnc \
        websockify \
        chromium \
        chromium-l10n \
        fontconfig \
        fonts-wqy-zenhei \
        fonts-wqy-microhei \
        fonts-noto-color-emoji \
        fonts-symbola; \
      mkdir -p /etc/fonts; \
      printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <alias>\n    <family>sans-serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>monospace</family>\n    <prefer>\n      <family>WenQuanYi Micro Hei Mono</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>emoji</family>\n    <prefer>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n</fontconfig>\n' > /etc/fonts/local.conf; \
      fc-cache -f; \
      find /usr/lib/chromium/locales -mindepth 1 -maxdepth 1 -type f ! -name 'zh-CN.pak' ! -name 'zh-TW.pak' ! -name 'en-US.pak' ! -name 'en-GB.pak' ! -name 'ja.pak' ! -name 'es.pak' ! -name 'fr.pak' ! -name 'de.pak' ! -name 'ru.pak' ! -name 'pt-BR.pak' -delete; \
      mkdir -p /etc/chromium/policies/managed; \
      printf '{"CommandLineFlagSecurityWarningsEnabled": false}\n' > /etc/chromium/policies/managed/disable-flag-warning.json; \
    else \
      echo "===> mini 变体：跳过桌面与 Chromium 依赖，仅保留中文字体 (fonts-wqy-microhei)"; \
      USE_CHINA_MIRROR="${USE_CHINA_MIRROR}" /usr/local/sbin/dsh-apt-install \
        fontconfig \
        fonts-wqy-microhei; \
      fc-cache -f; \
    fi

# 1.3 noVNC 静态资源版本化隔离与缓存击穿 (仅 INSTALL_DESKTOP=1 时执行)
ARG NOVNC_ASSET_REVISION=1.6.0
RUN set -eux; \
    if [ "$INSTALL_DESKTOP" = "1" ]; then \
      novnc_copy="$(mktemp -d)"; \
      cp -a /usr/share/novnc/. "${novnc_copy}/"; \
      mkdir -p "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}"; \
      cp -a "${novnc_copy}/." "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}/"; \
      rm -rf "${novnc_copy}"; \
      if [ ! -e /usr/share/novnc/index.html ]; then ln -s vnc.html /usr/share/novnc/index.html; fi; \
    else \
      echo "===> mini 变体：跳过 noVNC 静态资源版本化层"; \
    fi

# 1.4 跨平台 WSL2 / Docker Desktop 路径调用兼容 Shim
RUN cat > /usr/local/bin/wslpath <<'SHIM'
#!/bin/sh
out=""
for arg in "$@"; do
  case "$arg" in
    -w|-u|-m|--*) ;;
    *) out="$arg" ;;
  esac
done
printf '%s\n' "${out:-/}"
exit 0
SHIM
RUN chmod 0755 /usr/local/bin/wslpath

# 2. 安装官方 Golang 开发环境 (仅 full 变体或显式 --build-arg INSTALL_GO=1 时安装)
ARG GO_VERSION=""
RUN set -eux; \
    if [ "$INSTALL_GO" != "1" ]; then \
      echo "===> ${VARIANT} 变体：跳过 Go 工具链 (INSTALL_GO=${INSTALL_GO})"; \
    else \
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
        if curl -sSL --fail --connect-timeout 10 --max-time 900 --retry 2 --retry-delay 3 "https://golang.google.cn/dl/${GO_TARBALL}" -o /tmp/go.tar.gz; then \
          DOWNLOAD_SUCCESS=1; \
        fi; \
      fi; \
      if [ "${DOWNLOAD_SUCCESS}" = "0" ]; then \
        echo "===> 从全球官方源下载 Golang..."; \
        curl -sSL --fail --connect-timeout 10 --max-time 900 --retry 2 --retry-delay 3 "https://go.dev/dl/${GO_TARBALL}" -o /tmp/go.tar.gz; \
      fi; \
      tar -C /usr/local -xzf /tmp/go.tar.gz; \
      rm -f /tmp/go.tar.gz; \
      ln -sf /usr/local/go/bin/go /usr/local/bin/go; \
      ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt; \
      mkdir -p /go/src /go/bin /go/pkg /workspace; \
      chmod -R 0755 /go; \
      if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
        /usr/local/go/bin/go env -w GOPROXY="https://goproxy.cn,direct"; \
      fi; \
      printf 'export GOROOT=/usr/local/go\nexport GOPATH=/go\nexport PATH=$PATH:/usr/local/go/bin:/go/bin\n' > /etc/profile.d/go.sh; \
      go version; \
    fi

# 3. 从 builder 阶段复制官方 DSH / pnpm 及依赖 (保留软链拓扑；@deepseek-ai 以 1001:1001 单层写入支持非 root 切换与补丁)
COPY --from=builder /tmp/nm-other/ /usr/local/lib/node_modules/
COPY --from=builder --chown=1001:1001 /usr/local/lib/node_modules/@deepseek-ai /usr/local/lib/node_modules/@deepseek-ai
RUN set -eux; \
    chown 1001:1001 /usr/local/lib/node_modules/@deepseek-ai; \
    ln -sf /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh; \
    for b in pnpm pnpx pn pnx; do \
      if [ -e "/usr/local/lib/node_modules/pnpm/$b" ]; then \
        ln -sf "/usr/local/lib/node_modules/pnpm/$b" "/usr/local/bin/$b"; \
      fi; \
    done; \
    find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true; \
    find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true; \
    dsh --version || node -e "console.log(require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version)"; \
    # 【0.2.3-alpha.1 起】内置 DSH 的 engines.node 收紧为 ^24.22.3 || >=26.13.1（含 2026-11 内置 undici 安全修复）。\
    # 关键：DSH **运行期不做** engines 校验，npm 安装期也只给一条 EBADENGINE 警告、不失败 —— 所以底座 tag \
    # 写错或被重指时，构建依然"成功"，问题留到用户侧才暴露。这里补一道构建期硬断言。\
    node -e "const p=require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');const want=p.engines&&p.engines.node;if(!want){console.log('===> 内置 DSH 未声明 engines.node，跳过断言');process.exit(0)}let s=null;for(const c of ['/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/semver','semver']){try{s=require(c);break}catch{}}console.log('===> engines.node=' + want + ' / 当前 ' + process.version);const cur=process.versions.node.split('.').map(Number);const ge=(a,b)=>a[0]!==b[0]?a[0]>b[0]:a[1]!==b[1]?a[1]>b[1]:a[2]>=b[2];let okv=null;if(s){okv=s.satisfies(process.version,want)}else{const mins=want.split('||').map(function(a){const m=a.match(/[0-9]+[.][0-9]+[.][0-9]+/);return m?m[0].split('.').map(Number):null}).filter(Boolean);if(mins.length)okv=mins.some(function(m){return ge(cur,m)})}console.log('===> engines.node=' + want + ' / 当前 ' + process.version + ' / 校验方式=' + (s?'semver':'内置数值比较'));if(okv===null){console.error('错误: 无法解析内置 DSH 的 engines.node，拒绝在未校验的情况下继续');process.exit(1)}if(!okv){console.error('错误: 当前 Node (' + process.version + ') 不满足内置 DSH 的 engines.node (' + want + ')，请固定符合要求的底座镜像');process.exit(1)}console.log('===> Node 版本断言通过')"; \
    # 【Issue #11】跨架构原生包自检：禁止把 x64 原生制品带进 arm64 镜像（否则启动期 Cannot find the native Koffi module）\
    ARCH_TAG="$(node -p 'process.arch')"; \
    test -d "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@koromix/koffi-linux-${ARCH_TAG}" \
      || { echo "错误: 缺少当前架构 (linux-${ARCH_TAG}) 的原生包 @koromix/koffi-linux-${ARCH_TAG}；请确认 npm 安装在目标架构上下文执行" >&2; exit 1; }; \
    echo "===> 原生架构包自检通过: linux-${ARCH_TAG}"

# 4. 创建必要目录结构 (条件化 Chromium 与 Go 目录)
RUN set -eux; \
    getent group dsh >/dev/null || groupadd -g 1001 dsh || groupadd dsh; \
    getent passwd dsh >/dev/null || useradd -m -u 1001 -g dsh -s /bin/bash dsh || useradd -m -g dsh -s /bin/bash dsh; \
    mkdir -p /app/gateway /app/scripts /app/plugins /workspace /root/.dsh /root/.dsh-snapshots; \
    mkdir -p /home/dsh/.dsh /home/dsh/.dsh-snapshots /home/dsh/workspace /home/dsh/.npm /home/dsh/.cache/pnpm; \
    if [ "$INSTALL_DESKTOP" = "1" ]; then \
      mkdir -p /root/.config/chromium /home/dsh/.config/chromium; \
    fi; \
    if [ "$INSTALL_GO" = "1" ]; then \
      mkdir -p /go; \
      chown -R dsh:dsh /go; \
    fi; \
    chown -R dsh:dsh /home/dsh; \
    chmod 0755 /home/dsh; \
    id dsh

# 5. 复制项目脚本与网关程序
COPY plugins.market.list /app/plugins.market.list
COPY version.json /app/version.json
COPY scripts/ /app/scripts/
COPY gateway/ /app/gateway/
COPY plugins/ /app/plugins/

# 【Issue #11】mini 镜像移除内置浏览器插件
RUN if [ "$INSTALL_DESKTOP" != "1" ]; then rm -rf /app/plugins/dsh-browser-desktop; fi

# 5.1 插件运行期依赖解析（交付 1001:1001 属主以支持非 root 模式下同步软链）
RUN for p in /app/plugins/*/; do \
      [ -d "$p" ] || continue; \
      mkdir -p "${p}node_modules/@deepseek-ai"; \
      for d in /usr/local/lib/node_modules/@deepseek-ai/*; do \
        [ -e "$d" ] || continue; \
        n=$(basename "$d"); \
        if [ "$n" != "dsh" ] && [ ! -e "${p}node_modules/@deepseek-ai/$n" ]; then \
          ln -s "$d" "${p}node_modules/@deepseek-ai/$n"; \
        fi; \
      done; \
      chown -R 1001:1001 "${p}node_modules"; \
    done \
    && ls -l /app/plugins/*/node_modules/@deepseek-ai/ 2>/dev/null | head -20 || true

# 5.2 【Issue #11】调用运行时依赖精简脚本与 Node 头文件瘦身
RUN set -eux; \
    if [ -f /app/scripts/prune-runtime-deps.mjs ]; then \
      echo "===> 执行运行时依赖精简 (level=${PRUNE_LEVEL})..."; \
      node /app/scripts/prune-runtime-deps.mjs --root /usr/local/lib/node_modules --level "${PRUNE_LEVEL}"; \
    else \
      echo "===> 提示: /app/scripts/prune-runtime-deps.mjs 暂不存在，跳过脚本瘦身"; \
    fi; \
    if [ "${PRUNE_LEVEL}" = "mini" ] || [ "${VARIANT}" = "mini" ]; then \
      echo "===> mini 变体：移除 Node C/C++ 编译头文件 (/usr/local/include/node)"; \
      rm -rf /usr/local/include/node; \
    fi; \
    find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true; \
    find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true

# 6. 安装网关依赖、赋予脚本执行权限并在构建期以 1001:1001 执行客户端补丁与残留扫描 (同层清除 npm 缓存)
RUN set -eux; \
    cd /app/gateway && npm install --omit=dev; \
    npm cache clean --force && rm -rf /root/.npm /root/.cache/node-gyp; \
    chmod -R a+rX /app; \
    chmod 0755 /app/scripts/*.sh /app/scripts/*.mjs /app/scripts/lib/*.mjs 2>/dev/null || true; \
    chmod 0755 /app/scripts/entrypoint.sh; \
    if [ "$INSTALL_DESKTOP" = "1" ]; then \
      chmod 0755 /app/scripts/chromium-docker; \
      ln -sf /app/scripts/chromium-docker /usr/local/bin/chromium-docker; \
    fi; \
    npm config set registry https://registry.npmmirror.com 2>/dev/null || true; \
    which pnpm >/dev/null 2>&1 && pnpm config set registry https://registry.npmmirror.com 2>/dev/null || true; \
    echo "===> 构建期执行 DSH 客户端补丁 (--build) 与残留扫描..."; \
    setpriv --reuid=1001 --regid=1001 --clear-groups node /app/scripts/patch-dsh-client.mjs --build; \
    setpriv --reuid=1001 --regid=1001 --clear-groups node /app/scripts/lib/needle-scan.mjs --build; \
    rm -f /usr/local/sbin/dsh-apt-install

# 7. 配置工作目录与挂载卷声明
WORKDIR /workspace
VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/workspace", "/root/.config/chromium"]

# 8. 暴露统一对外的服务端口
EXPOSE 3080

# 9. 就绪探活：网关提供免鉴权 /healthz，跟随 PROXY_PORT 环境变量
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD sh -c 'curl -fsS "http://127.0.0.1:${PROXY_PORT:-3080}/healthz" || exit 1'

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
