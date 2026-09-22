#!/bin/bash
set -eo pipefail

export DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
export PROXY_PORT="${PROXY_PORT:-3080}"
export DSH_PORT="${DSH_PORT:-3079}"
export VNC_PORT="${VNC_PORT:-6080}"
# M13：ADMIN_PATH / VNC_PATH 只有在【显式设置】时才导出为环境变量；
# 未设置时不注入默认值，从而让管理后台写入的持久化配置继续生效（env 显式设置才优先）。
if [ -n "${ADMIN_PATH:-}" ]; then export ADMIN_PATH; fi
if [ -n "${VNC_PATH:-}" ]; then export VNC_PATH; fi
export NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
export DSH_DESKTOP_ENABLED="${DSH_DESKTOP_ENABLED:-1}"
export DSH_DESKTOP_WIDTH="${DSH_DESKTOP_WIDTH:-1920}"
export DSH_DESKTOP_HEIGHT="${DSH_DESKTOP_HEIGHT:-1080}"
export DSH_DESKTOP_DEPTH="${DSH_DESKTOP_DEPTH:-24}"
# M11：运行根目录可迁移（非 root 部署时设为 /home/<user>），默认 /root
export DSH_HOME="${DSH_HOME:-/root}"
export DSH_DIR="${DSH_HOME}/.dsh"
export DSH_SNAPSHOT_DIR="${DSH_SNAPSHOT_DIR:-${DSH_HOME}/.dsh-snapshots}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-${DSH_HOME}/.config/chromium}"
# 轻微项：DSH 日志落数据卷（便于排障与留存），并做简单的体积轮转
export DSH_WEB_LOG="${DSH_WEB_LOG:-${DSH_HOME:-/root}/.dsh/logs/dsh-web.log}"
export DSH_WEB_LOG_MAX_BYTES="${DSH_WEB_LOG_MAX_BYTES:-10485760}"
export NODE_OPTIONS="${NODE_OPTIONS} --no-deprecation"
export NODE_PATH="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules:/usr/local/lib/node_modules:${NODE_PATH}"

# 出站代理环境变量归一化 (兼容官方 0.1.5-rc.1 原生出站代理行为)
[ -n "$HTTP_PROXY" ] && export HTTP_PROXY="$HTTP_PROXY" http_proxy="${http_proxy:-$HTTP_PROXY}"
[ -n "$HTTPS_PROXY" ] && export HTTPS_PROXY="$HTTPS_PROXY" https_proxy="${https_proxy:-$HTTPS_PROXY}"
[ -n "$ALL_PROXY" ] && export ALL_PROXY="$ALL_PROXY" all_proxy="${all_proxy:-$ALL_PROXY}"
[ -n "$NO_PROXY" ] && export NO_PROXY="$NO_PROXY" no_proxy="${no_proxy:-$NO_PROXY}"

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
mkdir -p "${DSH_WORKSPACE}" "${DSH_DIR}" "${DSH_SNAPSHOT_DIR}" "${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop"
mkdir -p "$(dirname "${DSH_WEB_LOG}")" 2>/dev/null || true
if [ -f "${DSH_WEB_LOG}" ]; then
  _log_size=$(wc -c < "${DSH_WEB_LOG}" 2>/dev/null || echo 0)
  if [ "${_log_size:-0}" -gt "${DSH_WEB_LOG_MAX_BYTES}" ]; then
    mv -f "${DSH_WEB_LOG}" "${DSH_WEB_LOG}.1" 2>/dev/null || true
  fi
fi
touch "${DSH_WEB_LOG}"

# 1.0 自动配置 npm 与 pnpm 镜像源加速 (默认 npmmirror，海外可传 NPM_REGISTRY 覆盖)
NPM_REG="${NPM_REGISTRY:-https://registry.npmmirror.com}"
npm config set registry "${NPM_REG}" 2>/dev/null || true
which pnpm >/dev/null 2>&1 && pnpm config set registry "${NPM_REG}" 2>/dev/null || true

# 1.01 确保 node-pty 的 spawn-helper 具备可执行权限
find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true
find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true

# 1.1 修复 .dsh 目录与凭据文件的严格权限 (DSH 凭据服务强制校验 mode 600，拒绝 777/644 等跨权限读取崩溃)
if [ -d "${DSH_DIR}" ]; then
  chmod 700 "${DSH_DIR}" 2>/dev/null || true
  find "${DSH_DIR}" -name "*credentials*.yaml" -o -name "*credentials*.yml" 2>/dev/null | while read -r f; do
    chmod 600 "$f" || true
  done
fi

# 1.2 容器级配置预设：自官方 0.1.7 起，设置权威从 $DSH_DIR/settings.yaml 迁移到补丁层
#     （旧 settings.yaml 只在 DSH 启动后被导入一次并改名 settings.yaml.imported），
#     因此这里**不再**重建 settings.yaml——否则每次重启都会再次导入并回退用户在设置页改过的值。
#     容器级预设（市场重启守护、原生侧边栏浏览器开关）统一由 install-plugin.mjs 写入
#     Home 级补丁 $DSH_DIR/cordis.patch.yml（0.1.7 新增的最高优先级补丁层，对全部 profile 生效）。
#     存量容器若仍有 settings.yaml，交由 DSH 首次启动完成一次性迁移，此处不干预。

# 2. 自动注册并安装 dsh-browser-desktop 插件到 DSH profile
if [ -f "/app/scripts/install-plugin.mjs" ]; then
  echo "[entrypoint] 注册 dsh-browser-desktop 插件到 Web Profile..."
  node /app/scripts/install-plugin.mjs || true
fi

# 3. 运行客户端与服务端回环持久化补丁（必需补丁未命中会以非零码退出，这里显著告警但不阻断启动）
if [ -f "/app/scripts/patch-dsh-client.mjs" ]; then
  echo "[entrypoint] 执行 DSH 客户端回环与宿主设置持久化补丁..."
  if ! node /app/scripts/patch-dsh-client.mjs; then
    echo "[entrypoint] ⚠️⚠️⚠️ 必需补丁未生效（详见上方 [FATAL] 行）！"
    echo "[entrypoint] ⚠️ 服务仍会继续启动，但鉴权放行 / 回环 host 模式 / 插件包 404 自愈等补丁可能缺失；"
    echo "[entrypoint] ⚠️ 请尽快更新镜像，或同步修正 scripts/patch-dsh-client.mjs 的补丁锚点。"
  fi
fi

# 4. 启动统一网关守护循环
#    - 支持管理面板在线热重启网关（局部注入 NODE_ENV=production）
#    - 指数退避（1s→2s→…→30s）；连续 10 次失败则退出容器，交由编排层/用户介入
attempt=0
backoff=1
while true; do
  echo "[entrypoint] 启动网关..."
  start_ts=$(date +%s)
  NODE_ENV=production node /app/gateway/index.js &
  child_pid=$!
  code=0
  wait "$child_pid" || code=$?
  child_pid=""
  ran=$(( $(date +%s) - start_ts ))

  # 稳定运行超过 60s 视为一次成功启动：重置退避计数
  if [ "$ran" -ge 60 ]; then
    attempt=0
    backoff=1
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "[entrypoint] ❌ 网关已连续退出 ${attempt} 次（最近退出码 ${code}，运行 ${ran}s），放弃重启并退出容器"
    exit 1
  fi
  echo "[entrypoint] 网关进程已退出 (code=${code}，运行 ${ran}s)，${backoff}s 后重启（第 ${attempt} 次）..."
  sleep "$backoff"
  backoff=$(( backoff * 2 ))
  [ "$backoff" -gt 30 ] && backoff=30
done
