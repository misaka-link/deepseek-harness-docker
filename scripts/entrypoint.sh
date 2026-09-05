#!/bin/bash
set -eo pipefail

export DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
export PROXY_PORT="${PROXY_PORT:-3080}"
export DSH_PORT="${DSH_PORT:-3079}"
export VNC_PORT="${VNC_PORT:-6080}"
export ADMIN_PATH="${ADMIN_PATH:-/admin}"
export VNC_PATH="${VNC_PATH:-/vnc}"
export DSH_DESKTOP_ENABLED="${DSH_DESKTOP_ENABLED:-1}"
export DSH_DESKTOP_WIDTH="${DSH_DESKTOP_WIDTH:-1920}"
export DSH_DESKTOP_HEIGHT="${DSH_DESKTOP_HEIGHT:-1080}"
export DSH_DESKTOP_DEPTH="${DSH_DESKTOP_DEPTH:-24}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/root/.config/chromium}"
export DSH_WEB_LOG="/tmp/dsh-web.log"
export NODE_OPTIONS="${NODE_OPTIONS} --no-deprecation"
export NODE_PATH="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules:/usr/local/lib/node_modules:${NODE_PATH}"

child_pid=""

stop_all() {
  echo "[entrypoint] 收到停止信号，正在退出..."
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}

trap stop_all SIGINT SIGTERM SIGHUP

echo "========================================================"
echo "    启动 DeepSeek Harness"
echo "========================================================"

# 1. 确保必要目录就绪
mkdir -p "${DSH_WORKSPACE}" "/root/.dsh" "/root/.dsh-snapshots" "${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop"
touch "${DSH_WEB_LOG}"

# 1.1 修复 .dsh 目录与凭据文件的严格权限 (DSH 凭据服务强制校验 mode 600，拒绝 777/644 等跨权限读取崩溃)
if [ -d "/root/.dsh" ]; then
  chmod 700 /root/.dsh 2>/dev/null || true
  find /root/.dsh -name "*credentials*.yaml" -o -name "*credentials*.yml" 2>/dev/null | while read -r f; do
    chmod 600 "$f" || true
  done
fi

# 1.2 预设已确认内测声明与插件市场安全重启配置，防止弹窗阻塞与守护管理器双重启冲突
if [ ! -f "/root/.dsh/settings.yaml" ]; then
  cat <<'EOF' > /root/.dsh/settings.yaml
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
dsh-market:
  allowRestart: false
EOF
else
  if ! grep -q "welcomeNoticeVersion" "/root/.dsh/settings.yaml" 2>/dev/null; then
    printf '
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
' >> /root/.dsh/settings.yaml
  fi
  if ! grep -q "dsh-market:" "/root/.dsh/settings.yaml" 2>/dev/null; then
    printf '
dsh-market:
  allowRestart: false
' >> /root/.dsh/settings.yaml
  fi
fi

# 2. 自动注册并安装 dsh-browser-desktop 插件到 DSH profile
if [ -f "/app/scripts/install-plugin.mjs" ]; then
  echo "[entrypoint] 注册 dsh-browser-desktop 插件到 Web Profile..."
  node /app/scripts/install-plugin.mjs || true
fi

# 3. 运行客户端与服务端回环持久化补丁
if [ -f "/app/scripts/patch-dsh-client.mjs" ]; then
  echo "[entrypoint] 执行 DSH 客户端回环与宿主设置持久化补丁..."
  node /app/scripts/patch-dsh-client.mjs || true
fi

# 4. 启动统一网关守护循环 (支持管理面板在线热重启网关)
while true; do
  echo "[entrypoint] 启动网关..."
  node /app/gateway/index.js &
  child_pid=$!
  wait "$child_pid" || true
  child_pid=""
  echo "[entrypoint] 网关进程已退出，将在 1 秒后自动重启就绪..."
  sleep 1
done
