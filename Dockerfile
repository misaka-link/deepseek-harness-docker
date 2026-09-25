# ========================================================
# Dockerfile: deepseek-harness-docker
# Integrated DeepSeek Harness with Chromium Desktop & Unified Gateway
# Runtime base: Debian Trixie (glibc 2.41) & Node 24
# ========================================================

ARG NODE_IMAGE=node:24-trixie
FROM ${NODE_IMAGE}

LABEL maintainer="DeepSeek Harness Community"
LABEL description="Production Docker image for DeepSeek Harness with Container Browser, VNC, and Aesthetic Auth Gateway"

ENV DEBIAN_FRONTEND=noninteractive \
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
    psmisc \
    iproute2 \
    locales \
    python3 \
    python-is-python3 \
    build-essential \
    # 常用实用 CLI 研发工具 (Agent 任务开箱即用)
    file \
    jq \
    less \
    ripgrep \
    rsync \
    zip \
    unzip \
    # Tcl/Tk 图形工具 (支持桌面配置编辑器与跨平台 Shim)
    tk \
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

# 1.2 noVNC 静态资源版本化隔离与缓存击穿 (杜绝升级后浏览器混用旧缓存导致 WebCodecs 崩溃或白屏)
ARG NOVNC_ASSET_REVISION=1.6.0
RUN novnc_copy="$(mktemp -d)" \
    && cp -a /usr/share/novnc/. "${novnc_copy}/" \
    && mkdir -p "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}" \
    && cp -a "${novnc_copy}/." "/usr/share/novnc/novnc-${NOVNC_ASSET_REVISION}/" \
    && rm -rf "${novnc_copy}" \
    && if [ ! -e /usr/share/novnc/index.html ]; then ln -s vnc.html /usr/share/novnc/index.html; fi

# 1.3 跨平台 WSL2 / Docker Desktop 路径调用兼容 Shim (修复 Web UI 点击打开配置/目录报 spawn wslpath ENOENT)
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
    chmod -R 0755 /go; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      /usr/local/go/bin/go env -w GOPROXY="https://goproxy.cn,direct"; \
    fi; \
    go version

# 3. 全局安装 DeepSeek Harness 官方 CLI 与 pnpm（M10：固定版本 + 校验完整性 + 安装期不执行包脚本）
#    版本默认来自 build.sh 读取的 version.json#supply，可用 --build-arg 覆盖。
ARG DSH_VERSION="0.1.7-rc.2"
ARG PNPM_VERSION="12.5.1"
RUN set -eux; \
    TARGET_PKG="@deepseek-ai/dsh@${DSH_VERSION}"; \
    echo "===> 正在安装 DeepSeek Harness 官方核心: ${TARGET_PKG} (pnpm@${PNPM_VERSION})..."; \
    if [ "$USE_CHINA_MIRROR" = "1" ] || [ "$USE_CHINA_MIRROR" = "true" ]; then \
      PRIMARY_REG="https://registry.npmmirror.com"; ALT_REG="https://registry.npmjs.org"; \
    else \
      PRIMARY_REG="https://registry.npmjs.org"; ALT_REG="https://registry.npmmirror.com"; \
    fi; \
    echo "===> 主源 ${PRIMARY_REG}；备用源 ${ALT_REG}"; \
    mkdir -p /tmp/dsh-pkg; \
    INTEG="$(npm view "${TARGET_PKG}" dist.integrity --registry="${PRIMARY_REG}" 2>/dev/null || npm view "${TARGET_PKG}" dist.integrity --registry="${ALT_REG}" 2>/dev/null || true)"; \
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
    dsh --version || node -e "console.log(require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version)"

# 3.1 按需预装社区插件清单 (默认关闭 PREINSTALL_PLUGINS=0；设为 1 时自动安装 plugins.market.list)
ARG PREINSTALL_PLUGINS=0
# 预装层缓存刷新键：传成每次构建都不同的值（CI 用 run_id，本地用时间戳），
# 强制本 RUN 层缓存失效并重新执行 —— 否则 plugins.market.list 内容不变时 Docker
# 直接复用旧层，写成 @latest 的插件（如 dshmarket）永远拉不到新版。
ARG MARKET_REFRESH=""
COPY plugins.market.list /app/plugins.market.list
RUN if [ "$PREINSTALL_PLUGINS" = "1" ] || [ "$PREINSTALL_PLUGINS" = "true" ]; then \
      echo "===> 正在根据 plugins.market.list 预装社区插件清单 (Market 变体, refresh=${MARKET_REFRESH:-none})..." \
      && sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' /app/plugins.market.list \
         | grep -v '^$' \
         | xargs -r npm install -g --ignore-scripts \
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
# M11：新增非 root 用户 dsh(uid 1000)。默认仍以 root 运行以兼容既有数据卷（/root/.dsh）；
#       需要非 root 运行时：compose 里设置 user: "1000:1000" 且 DSH_HOME=/home/dsh，
#       并把数据卷改挂到 /home/dsh/.dsh 等路径（详见 README 与 .env.example）。
RUN set -eux; \
    getent group dsh >/dev/null || groupadd -g 1001 dsh || groupadd dsh; \
    getent passwd dsh >/dev/null || useradd -m -u 1001 -g dsh -s /bin/bash dsh || useradd -m -g dsh -s /bin/bash dsh; \
    mkdir -p /app/gateway /app/scripts /app/plugins /workspace /root/.dsh /root/.dsh-snapshots /root/.config/chromium /go \
    && mkdir -p /home/dsh/.dsh /home/dsh/.dsh-snapshots /home/dsh/.config/chromium /home/dsh/workspace \
    && chown -R dsh:dsh /home/dsh /go \
    && chmod 0755 /home/dsh \
    && id dsh

# 5. 复制项目脚本与网关程序
COPY version.json /app/version.json
COPY scripts/ /app/scripts/
COPY gateway/ /app/gateway/
COPY plugins/ /app/plugins/

# 5.1 插件运行期依赖解析（M12）：构建上下文已排除 node_modules，这里显式创建指向
#     官方 DSH 内置依赖的软链，避免依赖"宿主绝对路径软链"这种构建残留。
#     （插件 index.js 直接 import '@deepseek-ai/schemastery'，其解析路径为
#       /app/plugins/<plugin>/node_modules/@deepseek-ai/*）
RUN for p in /app/plugins/*/; do \
      mkdir -p "${p}node_modules/@deepseek-ai"; \
      for d in /usr/local/lib/node_modules/@deepseek-ai/*; do \
        n=$(basename "$d"); \
        if [ "$n" != "dsh" ] && [ ! -e "${p}node_modules/@deepseek-ai/$n" ]; then \
          ln -s "$d" "${p}node_modules/@deepseek-ai/$n"; \
        fi; \
      done; \
    done \
    && ls -l /app/plugins/*/node_modules/@deepseek-ai/ | head -20

# 6. 安装网关依赖并赋予脚本执行权限
RUN cd /app/gateway && npm install --omit=dev \
    && chmod +x /app/scripts/entrypoint.sh /app/scripts/chromium-docker \
    && ln -s /app/scripts/chromium-docker /usr/local/bin/chromium-docker \
    && npm config set registry https://registry.npmmirror.com 2>/dev/null || true \
    && which pnpm >/dev/null 2>&1 && pnpm config set registry https://registry.npmmirror.com 2>/dev/null || true

# 7. 配置工作目录与挂载卷声明
WORKDIR /workspace
VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/workspace", "/root/.config/chromium"]

# 8. 暴露统一对外的服务端口
EXPOSE 3080

# 9. 就绪探活：网关提供免鉴权 /healthz；连续失败会被编排层标记为 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3080/healthz || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
