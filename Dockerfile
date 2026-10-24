# ========================================================
# Dockerfile: deepseek-harness-docker
# Integrated DeepSeek Harness with Container Browser, VNC & Unified Gateway
# Multi-stage build supporting full, market, and mini (Issue #11 C-tier)
# ========================================================

ARG NODE_IMAGE=node:24-trixie

# ========================================================
# Stage 1: builder —— 负责安装 DSH 核心、pnpm、编译原生模块与预装插件
# ========================================================
FROM ${NODE_IMAGE} AS builder

# 0. 配置国内 USTC 镜像源加速 (Debian + npm)
ARG USE_CHINA_MIRROR=1
RUN if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
      npm config set registry https://registry.npmmirror.com; \
    fi

# builder 编译所需最小工具链 (build-essential/python3 用于 node-pty 原生编译)
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      python-is-python3 \
      ca-certificates \
      curl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 全局安装 DeepSeek Harness 官方 CLI 与 pnpm (固定版本 + 校验完整性 + 安装期不执行包脚本)
ARG DSH_VERSION="0.2.1-rc.3"
ARG PNPM_VERSION="12.5.1"
ARG DSH_INTEGRITY="sha512-H+E9HLnHf7fJqzen84Z9Bq8ggb5xbrcbyhZjXTJLE9NabHr3zteGvTRvdvGkxPl4ov80is4WLglFmSo+/olJjg=="
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

# ========================================================
# Stage 2: runtime —— 最终运行镜像 (Issue #11 C 档支持)
# ========================================================
FROM ${NODE_IMAGE} AS runtime

# 【Issue #11】变体契约：full | mini（默认 full，向后兼容）
ARG VARIANT=full
ARG INSTALL_DESKTOP=1
ARG INSTALL_GO=1
ARG PRUNE_LEVEL=full

LABEL maintainer="DeepSeek Harness Community"
LABEL description="Production Docker image for DeepSeek Harness with Container Browser, VNC, and Aesthetic Auth Gateway"
LABEL org.opencontainers.image.variant="${VARIANT}"

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_VARIANT=${VARIANT} \
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

# 0. 配置国内 USTC 镜像源加速 (Debian + npm，默认开启)
ARG USE_CHINA_MIRROR=1
RUN if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list 2>/dev/null || true; \
      npm config set registry https://registry.npmmirror.com; \
    fi

# 1. 安装基础依赖与实用 CLI 研发工具 (A 层：三镜像共享缓存，不包含变体 ARG)
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
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
      tzdata; \
    echo "zh_CN.UTF-8 UTF-8" >> /etc/locale.gen; \
    locale-gen zh_CN.UTF-8; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

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
          && rm -rf /tmp/gh*) \
      && apt-get clean && rm -rf /var/lib/apt/lists/* \
      && gh --version; \
    fi

# 1.2 X11/VNC 桌面环境、Chromium 与字体 (B 层：mini 变体跳过桌面与浏览器，仅安装中文字体)
RUN set -eux; \
    if [ "$INSTALL_DESKTOP" = "1" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        tk \
        xvfb \
        x11-utils \
        xdotool \
        scrot \
        openbox \
        x11vnc \
        novnc \
        websockify \
        chromium \
        fontconfig \
        fonts-wqy-zenhei \
        fonts-wqy-microhei \
        fonts-noto-color-emoji \
        fonts-symbola; \
      mkdir -p /etc/fonts; \
      printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <alias>\n    <family>sans-serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>monospace</family>\n    <prefer>\n      <family>WenQuanYi Micro Hei Mono</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>emoji</family>\n    <prefer>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n</fontconfig>\n' > /etc/fonts/local.conf; \
      fc-cache -f; \
      apt-get clean; \
      rm -rf /var/lib/apt/lists/*; \
    else \
      echo "===> mini 变体：跳过桌面与 Chromium 依赖，仅保留中文字体 (fonts-wqy-microhei)"; \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        fontconfig \
        fonts-wqy-microhei; \
      fc-cache -f; \
      apt-get clean; \
      rm -rf /var/lib/apt/lists/*; \
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
RUN cat > /usr/local/bin/powershell.exe <<'SHIM'
#!/bin/sh
[ -x /usr/bin/wish ] || exit 0
command_text=""
for arg in "$@"; do
  case "$arg" in
    -NoProfile|-Command) ;;
    *) command_text="$arg" ;;
  esac
done
path=""
if [ -n "$command_text" ]; then
  path=$(printf '%s' "$command_text" \
    | sed -n "s/.*-LiteralPath[[:space:]]*'\([^']*\)'[[:space:]]*$/\1/p" \
    | sed "s/''/'/g")
fi
if [ -z "$path" ] || [ ! -e "$path" ]; then exit 0; fi
DISPLAY="${DISPLAY:-:99}" /usr/bin/wish /usr/local/bin/dsh-editor.tcl "$path" >/dev/null 2>&1 &
exit 0
SHIM
RUN cat > /usr/local/bin/dsh-editor.tcl <<'SHIM'
#!/usr/bin/wish
set target [lindex $argv 0]
if {$target eq ""} { exit }

if {[file isdirectory $target]} {
  wm title . "DSH Workspace: $target"
  wm geometry . 680x520
  listbox .lb -width 90 -height 30 -yscrollcommand {.vs set}
  scrollbar .vs -command {.lb yview}
  pack .lb -side left -fill both -expand true
  pack .vs -side right -fill y
  foreach f [lsort [glob -nocomplain -directory $target *]] {
    .lb insert end [file tail $f]
  }
  bind .lb <Double-Button-1> {
    set sel [lindex [.lb curselection] 0]
    if {$sel ne ""} {
      exec wish [info script] [file join $target [.lb get $sel]] &
    }
  }
  return
}

wm title . "DSH Config Editor: $target"
wm geometry . 900x640
frame .bar
button .bar.save -text "Save (Ctrl+S)" -command saveFile
button .bar.close -text "Close (Ctrl+W)" -command exit
label .bar.path -text $target -anchor w
pack .bar.save .bar.close -side left -padx 3 -pady 3
pack .bar.path -side left -fill x -expand true -padx 6
pack .bar -side top -fill x

text .txt -wrap word -undo true -yscrollcommand {.vs set} -font {TkFixedFont 11}
scrollbar .vs -command {.txt yview}
pack .txt -side left -fill both -expand true
pack .vs -side right -fill y

if {[catch {set fd [open $target r]; fconfigure $fd -encoding utf-8; set content [read $fd]; close $fd} err]} {
  tk_messageBox -message "Open failed: $err" -type ok -icon warning
  exit
}
.txt insert 1.0 $content
focus .txt

proc saveFile {} {
  global target
  if {[catch {
    set fd [open $target w]
    fconfigure $fd -encoding utf-8
    puts -nonewline $fd [.txt get 1.0 end-1c]
    close $fd
  } err]} {
    tk_messageBox -message "Save failed: $err" -type ok -icon error
    return
  }
  .bar.save configure -text "Saved ✓"
  after 1200 { .bar.save configure -text "Save (Ctrl+S)" }
}
bind .txt <Control-s> saveFile
bind .txt <Control-w> exit
bind . <Control-s> saveFile
bind . <Control-w> exit
SHIM
RUN chmod 0755 /usr/local/bin/wslpath /usr/local/bin/powershell.exe /usr/local/bin/dsh-editor.tcl

# 2. 安装官方 Golang 开发环境 (【Issue #11】mini 变体通过 INSTALL_GO=0 跳过)
ARG GO_VERSION=""
RUN set -eux; \
    if [ "$INSTALL_GO" != "1" ]; then \
      echo "===> mini 变体：跳过 Go 工具链"; \
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

# 3. 从 builder 阶段复制官方 DSH / pnpm 及依赖 (保留软链拓扑)
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN set -eux; \
    ln -sf /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh; \
    for b in pnpm pnpx pn pnx; do \
      if [ -e "/usr/local/lib/node_modules/pnpm/$b" ]; then \
        ln -sf "/usr/local/lib/node_modules/pnpm/$b" "/usr/local/bin/$b"; \
      fi; \
    done; \
    find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true; \
    find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true; \
    dsh --version || node -e "console.log(require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version)"; \
    # 【Issue #11 / DQ4】跨架构原生包自检：禁止把 x64 原生制品带进 arm64 镜像（否则启动期 Cannot find the native Koffi module）\
    ARCH_TAG="$(node -p 'process.arch')"; \
    test -d "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@koromix/koffi-linux-${ARCH_TAG}" \
      || { echo "错误: 缺少当前架构 (linux-${ARCH_TAG}) 的原生包 @koromix/koffi-linux-${ARCH_TAG}；请确认 npm 安装在目标架构上下文执行" >&2; exit 1; }; \
    echo "===> 原生架构包自检通过: linux-${ARCH_TAG}"

# 4. 创建必要目录结构 (条件化 Chromium 与 Go 目录)
RUN set -eux; \
    getent group dsh >/dev/null || groupadd -g 1001 dsh || groupadd dsh; \
    getent passwd dsh >/dev/null || useradd -m -u 1001 -g dsh -s /bin/bash dsh || useradd -m -g dsh -s /bin/bash dsh; \
    mkdir -p /app/gateway /app/scripts /app/plugins /workspace /root/.dsh /root/.dsh-snapshots; \
    mkdir -p /home/dsh/.dsh /home/dsh/.dsh-snapshots /home/dsh/workspace; \
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

# 5.1 插件运行期依赖解析
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

# 6. 安装网关依赖并赋予脚本执行权限 (同层清除 npm 缓存)
RUN set -eux; \
    cd /app/gateway && npm install --omit=dev; \
    npm cache clean --force && rm -rf /root/.npm /root/.cache/node-gyp; \
    chmod +x /app/scripts/*.sh /app/scripts/*.mjs 2>/dev/null || true; \
    chmod +x /app/scripts/entrypoint.sh; \
    if [ "$INSTALL_DESKTOP" = "1" ]; then \
      chmod +x /app/scripts/chromium-docker; \
      ln -sf /app/scripts/chromium-docker /usr/local/bin/chromium-docker; \
    fi; \
    npm config set registry https://registry.npmmirror.com 2>/dev/null || true; \
    which pnpm >/dev/null 2>&1 && pnpm config set registry https://registry.npmmirror.com 2>/dev/null || true

# 7. 配置工作目录与挂载卷声明
WORKDIR /workspace
VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/workspace", "/root/.config/chromium"]

# 8. 暴露统一对外的服务端口
EXPOSE 3080

# 9. 就绪探活：网关提供免鉴权 /healthz；连续失败会被编排层标记为 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3080/healthz || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
