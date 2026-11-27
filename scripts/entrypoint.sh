#!/bin/bash
set -eo pipefail

export DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
export PROXY_PORT="${PROXY_PORT:-3080}"
export DSH_PORT="${DSH_PORT:-3079}"
export VNC_PORT="${VNC_PORT:-6080}"
# ADMIN_PATH / VNC_PATH 仅在显式设置时导出，未设置时沿用数据卷中的持久化配置
if [ -n "${ADMIN_PATH:-}" ]; then export ADMIN_PATH; fi
if [ -n "${VNC_PATH:-}" ]; then export VNC_PATH; fi
export NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
# 变体标记（默认 standard），mini 变体强制关闭桌面栈
export DSH_VARIANT="${DSH_VARIANT:-standard}"
if [ "${DSH_VARIANT}" = "mini" ]; then
  export DSH_DESKTOP_ENABLED=0
else
  export DSH_DESKTOP_ENABLED="${DSH_DESKTOP_ENABLED:-1}"
fi
export DSH_DESKTOP_WIDTH="${DSH_DESKTOP_WIDTH:-1920}"
export DSH_DESKTOP_HEIGHT="${DSH_DESKTOP_HEIGHT:-1080}"
export DSH_DESKTOP_DEPTH="${DSH_DESKTOP_DEPTH:-24}"

# 路径统一（与 gateway/src/core/paths.js 保持完全一致）
export DSH_HOME="${DSH_HOME:-/root}"
if [ -z "${DSH_DIR:-}" ]; then
  if [ "$(basename "${DSH_HOME}")" = ".dsh" ]; then
    export DSH_DIR="${DSH_HOME}"
  else
    export DSH_DIR="${DSH_HOME}/.dsh"
  fi
else
  export DSH_DIR
fi
# 统一导出复数与单数快照目录变量，两者取值完全一致
_SNAP_RESOLVED="${DSH_SNAPSHOTS_DIR:-${DSH_SNAPSHOT_DIR:-${DSH_HOME}/.dsh-snapshots}}"
export DSH_SNAPSHOTS_DIR="${_SNAP_RESOLVED}"
export DSH_SNAPSHOT_DIR="${_SNAP_RESOLVED}"
export DSH_VERSIONS_DIR="${DSH_VERSIONS_DIR:-${DSH_SNAPSHOTS_DIR}/versions}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-${DSH_HOME}/.config/chromium}"
export DSH_WEB_LOG="${DSH_WEB_LOG:-${DSH_DIR}/logs/dsh-web.log}"
export DSH_WEB_LOG_MAX_BYTES="${DSH_WEB_LOG_MAX_BYTES:-10485760}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-deprecation"
export NODE_PATH="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules:/usr/local/lib/node_modules:${NODE_PATH:-}"

# 出站代理环境变量归一化（启用代理时自动保底 127.0.0.1/localhost/::1 直连，防止内部回环流量被外代劫持）
[ -n "${HTTP_PROXY:-}" ] && export HTTP_PROXY="$HTTP_PROXY" http_proxy="${http_proxy:-$HTTP_PROXY}"
[ -n "${http_proxy:-}" ] && export http_proxy="$http_proxy" HTTP_PROXY="${HTTP_PROXY:-$http_proxy}"
[ -n "${HTTPS_PROXY:-}" ] && export HTTPS_PROXY="$HTTPS_PROXY" https_proxy="${https_proxy:-$HTTPS_PROXY}"
[ -n "${https_proxy:-}" ] && export https_proxy="$https_proxy" HTTPS_PROXY="${HTTPS_PROXY:-$https_proxy}"
[ -n "${ALL_PROXY:-}" ] && export ALL_PROXY="$ALL_PROXY" all_proxy="${all_proxy:-$ALL_PROXY}"
[ -n "${all_proxy:-}" ] && export all_proxy="$all_proxy" ALL_PROXY="${ALL_PROXY:-$all_proxy}"
if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}${http_proxy:-}${https_proxy:-}${all_proxy:-}" ]; then
  _raw_no_proxy="${NO_PROXY:-}"
  if [ -n "${no_proxy:-}" ] && [ "${no_proxy}" != "${_raw_no_proxy}" ]; then
    _raw_no_proxy="${_raw_no_proxy:+${_raw_no_proxy},}${no_proxy}"
  fi
  _merged_no_proxy=""
  IFS=',' read -r -a _np_items <<< "${_raw_no_proxy},127.0.0.1,localhost,::1"
  for _item in "${_np_items[@]}"; do
    _item="${_item#"${_item%%[![:space:]]*}"}"
    _item="${_item%"${_item##*[![:space:]]}"}"
    [ -n "${_item}" ] || continue
    case ",${_merged_no_proxy}," in
      *",${_item},"*) ;;
      *) _merged_no_proxy="${_merged_no_proxy:+${_merged_no_proxy},}${_item}" ;;
    esac
  done
  export NO_PROXY="${_merged_no_proxy}" no_proxy="${_merged_no_proxy}"
elif [ -n "${NO_PROXY:-}" ] || [ -n "${no_proxy:-}" ]; then
  _merged_no_proxy="${NO_PROXY:-${no_proxy:-}}"
  export NO_PROXY="${_merged_no_proxy}" no_proxy="${_merged_no_proxy}"
fi

# ── 第 0 步 (a)：可选 PUID / PGID 自动修正属主并降权启动 ──────────────────────
# 以 root 启动且显式设置了 PUID 或 PGID（非 0:0）时，自动修正挂载数据卷与引擎核心属主，
# 随后通过 setpriv 降权重新执行本入口脚本，保证后续全部进程均以非 root 运行。
if [ "$(id -u)" = "0" ] && [ -z "${_DSH_PRIV_DROPPED:-}" ] && { [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; }; then
  _TARGET_UID="${PUID:-1001}"
  _TARGET_GID="${PGID:-${_TARGET_UID}}"
  if ! [[ "${_TARGET_UID}" =~ ^[0-9]+$ ]] || ! [[ "${_TARGET_GID}" =~ ^[0-9]+$ ]]; then
    echo "[entrypoint] ❌ 非法的 PUID/PGID 值 (PUID=${PUID:-}, PGID=${PGID:-})，必须为非负整数" >&2
    exit 1
  fi
  if [ "${_TARGET_UID}" != "0" ] || [ "${_TARGET_GID}" != "0" ]; then
    echo "[entrypoint] 检测到 PUID=${_TARGET_UID} PGID=${_TARGET_GID}，正在修正挂载目录属主并降权启动..."
    mkdir -p "${DSH_WORKSPACE}" "${DSH_DIR}" "${DSH_SNAPSHOTS_DIR}" "${DSH_VERSIONS_DIR}" "$(dirname "${DSH_WEB_LOG}")" 2>/dev/null || true
    if [ "${DSH_VARIANT}" != "mini" ]; then
      mkdir -p "${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop" 2>/dev/null || true
    fi
    # 若仍沿用默认 DSH_HOME=/root，确保 /root 可被目标 UID 穿越进入子挂载点
    if [ "${DSH_HOME}" = "/root" ]; then
      chmod 0755 /root 2>/dev/null || true
      mkdir -p /root/.npm /root/.cache/pnpm 2>/dev/null || true
      chmod 0755 /root/.cache 2>/dev/null || true
    else
      mkdir -p "${DSH_HOME}/.npm" "${DSH_HOME}/.cache/pnpm" 2>/dev/null || true
    fi
    export HOME="${DSH_HOME}"
    _CHOWN_TARGETS=(
      "${DSH_DIR}"
      "${DSH_SNAPSHOTS_DIR}"
      "${DSH_WORKSPACE}"
      "/usr/local/lib/node_modules/@deepseek-ai"
      "${DSH_HOME}/.npm"
      "${DSH_HOME}/.cache/pnpm"
    )
    if [ "${DSH_VARIANT}" != "mini" ]; then
      _CHOWN_TARGETS+=("${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop")
    fi
    for _dir in "${_CHOWN_TARGETS[@]}"; do
      [ -e "${_dir}" ] || continue
      find "${_dir}" \( ! -uid "${_TARGET_UID}" -o ! -gid "${_TARGET_GID}" \) -exec chown -h "${_TARGET_UID}:${_TARGET_GID}" {} + 2>/dev/null || true
    done
    export _DSH_PRIV_DROPPED=1
    if command -v setpriv >/dev/null 2>&1; then
      if getent passwd "${_TARGET_UID}" >/dev/null 2>&1; then
        exec setpriv --reuid="${_TARGET_UID}" --regid="${_TARGET_GID}" --init-groups "$0" "$@"
      else
        exec setpriv --reuid="${_TARGET_UID}" --regid="${_TARGET_GID}" --clear-groups "$0" "$@"
      fi
    else
      echo "[entrypoint] ⚠️ 未找到 setpriv，无法降权，将以当前用户继续运行" >&2
    fi
  fi
fi

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
echo "    启动 DeepSeek Harness (uid=$(id -u), gid=$(id -g))"
echo "========================================================"

# ── 第 0 步 (b)：当前用户权限 Preflight 自检 ───────────────────────────────────
_preflight_failed=0
_cur_uid="$(id -u)"
_cur_gid="$(id -g)"

# 先尽力创建目录
if [ "${DSH_VARIANT}" = "mini" ]; then
  mkdir -p "${DSH_WORKSPACE}" "${DSH_DIR}" "${DSH_SNAPSHOTS_DIR}" 2>/dev/null || true
else
  mkdir -p "${DSH_WORKSPACE}" "${DSH_DIR}" "${DSH_SNAPSHOTS_DIR}" "${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop" 2>/dev/null || true
fi

for _rw_dir in "${DSH_DIR}" "${DSH_SNAPSHOTS_DIR}" "${DSH_WORKSPACE}"; do
  if [ ! -d "${_rw_dir}" ] || [ ! -r "${_rw_dir}" ] || [ ! -w "${_rw_dir}" ]; then
    echo "[entrypoint] ❌ [Preflight] 目录不可读写: ${_rw_dir} (当前 uid=${_cur_uid}, gid=${_cur_gid})" >&2
    _preflight_failed=1
  fi
done

_CFG_FILE="${GATEWAY_CONFIG_FILE:-${DSH_DIR}/gateway.config.json}"
_SEC_FILE="${SESSION_SECRET_FILE:-${DSH_DIR}/.session_secret}"
_CRED_FILE="${DSH_DIR}/.credentials.yaml"
for _crit_file in "${_CFG_FILE}" "${_SEC_FILE}" "${_CRED_FILE}"; do
  if [ -e "${_crit_file}" ] && [ ! -r "${_crit_file}" ]; then
    echo "[entrypoint] ❌ [Preflight] 关键文件存在但当前用户不可读: ${_crit_file} (uid=${_cur_uid}, gid=${_cur_gid})" >&2
    _preflight_failed=1
  fi
done

if [ "${_preflight_failed}" = "1" ]; then
  echo "[entrypoint] ⚠️ 检测到数据卷权限不匹配！如使用非 root 运行，请在宿主机执行：" >&2
  echo "[entrypoint] ⚠️   chown -R ${_cur_uid}:${_cur_gid} ./data ./workspace" >&2
  echo "[entrypoint] ⚠️ 或改用 root 启动并配置环境变量 PUID=${_cur_uid} PGID=${_cur_gid} 自动修正属主。" >&2
  echo "[entrypoint] ⚠️ 网关将以安全保护模式启动（存在不可读配置文件时绝不会开放 /setup）。" >&2
fi

# 1. 日志目录与轮转
mkdir -p "$(dirname "${DSH_WEB_LOG}")" 2>/dev/null || true
if [ -f "${DSH_WEB_LOG}" ]; then
  _log_size=$(wc -c < "${DSH_WEB_LOG}" 2>/dev/null || echo 0)
  if [ "${_log_size:-0}" -gt "${DSH_WEB_LOG_MAX_BYTES}" ]; then
    mv -f "${DSH_WEB_LOG}" "${DSH_WEB_LOG}.1" 2>/dev/null || true
  fi
fi
touch "${DSH_WEB_LOG}" 2>/dev/null || echo "[entrypoint] ⚠️ 无法创建日志文件: ${DSH_WEB_LOG}" >&2

# 1.0 自动配置 npm 与 pnpm 镜像源加速
NPM_REG="${NPM_REGISTRY:-https://registry.npmmirror.com}"
npm config set registry "${NPM_REG}" 2>/dev/null || true
command -v pnpm >/dev/null 2>&1 && pnpm config set registry "${NPM_REG}" 2>/dev/null || true

# 1.01 确保 node-pty 的 spawn-helper 具备可执行权限
find /usr/local/lib/node_modules -name "spawn-helper" -exec chmod 0755 {} + 2>/dev/null || true
find /usr/local/lib/node_modules -name "ensure-spawn-helper.mjs" -exec node {} + 2>/dev/null || true

# 1.02 工具缓存清单自愈（npx / pnpm dlx）
_TOOL_CACHE_NPM="${NPM_CONFIG_CACHE:-${HOME:-${DSH_HOME}}/.npm}/_npx"
_TOOL_CACHE_PNPM="${XDG_CACHE_HOME:-${HOME:-${DSH_HOME}}/.cache}/pnpm/dlx"
if [ -d "${_TOOL_CACHE_NPM}" ] || [ -d "${_TOOL_CACHE_PNPM}" ]; then
  node /app/scripts/tool-cache-heal.mjs --boot --quiet 2>&1 | sed 's/^/[entrypoint] /' || true
fi

# 1.1 修复 .dsh 目录与凭据文件的严格权限（chmod 600 失败必须显式告警）
if [ -d "${DSH_DIR}" ]; then
  if ! chmod 700 "${DSH_DIR}" 2>/dev/null; then
    echo "[entrypoint] ⚠️ 无法将 ${DSH_DIR} 权限设为 700（请检查目录属主与挂载权限）" >&2
  fi
  while IFS= read -r _f; do
    [ -n "${_f}" ] || continue
    if ! chmod 600 "${_f}" 2>/dev/null; then
      echo "[entrypoint] ⚠️ 无法将凭据文件 ${_f} 权限设为 600（DSH 凭据服务要求 0600，请检查文件属主: chown ${_cur_uid}:${_cur_gid}）" >&2
    fi
  done < <(find "${DSH_DIR}" -maxdepth 2 \( -name "*credentials*.yaml" -o -name "*credentials*.yml" \) 2>/dev/null)
fi

# 1.15 版本库目录就绪 + 活动核心中断自愈 + 过期残留清理 + 持久化自检
mkdir -p "${DSH_VERSIONS_DIR}/.staging" 2>/dev/null || true

CORE_PARENT="/usr/local/lib/node_modules/@deepseek-ai"
CORE_DIR="${CORE_PARENT}/dsh"

_core_entry_ok() {
  [ -f "$1/lib/bin.js" ] && return 0
  _entry=$(node -e "try{const p=require(process.argv[1]+'/package.json');const b=p.bin;const v=typeof b==='string'?b:(b&&Object.values(b)[0]);process.stdout.write(v||'')}catch(e){}" "$1" 2>/dev/null)
  [ -n "${_entry}" ] && [ -f "$1/${_entry}" ]
}

_core_ok() {
  [ -d "${CORE_DIR}" ] \
    && [ -f "${CORE_DIR}/package.json" ] \
    && [ -d "${CORE_DIR}/node_modules" ] \
    && [ -n "$(ls -A "${CORE_DIR}/node_modules" 2>/dev/null)" ] \
    && _core_entry_ok "${CORE_DIR}"
}

if ! _core_ok; then
  _rb=""
  for _cand in $(ls -1dt "${CORE_PARENT}"/.dsh-rollback-tmp-* 2>/dev/null); do
    if [ -f "${_cand}/package.json" ] && [ -n "$(ls -A "${_cand}/node_modules" 2>/dev/null)" ] && _core_entry_ok "${_cand}"; then
      _rb="${_cand}"
      break
    fi
  done
  if [ -z "${_rb}" ] && [ -d "${CORE_PARENT}/.dsh-rollback-preserved" ] \
     && [ -f "${CORE_PARENT}/.dsh-rollback-preserved/package.json" ] \
     && _core_entry_ok "${CORE_PARENT}/.dsh-rollback-preserved"; then
    _rb="${CORE_PARENT}/.dsh-rollback-preserved"
  fi
  if [ -n "${_rb}" ] && [ -d "${_rb}" ]; then
    echo "[entrypoint] ⚠️ 检测到活动核心缺失或不完整，正在从回滚点恢复: ${_rb}"
    [ -d "${CORE_DIR}" ] && rm -rf "${CORE_DIR}" 2>/dev/null || true
    mv "${_rb}" "${CORE_DIR}" 2>/dev/null || true
    if _core_ok; then
      echo "[entrypoint] ✅ 核心已从回滚点恢复"
    else
      echo "[entrypoint] ❌ 回滚点恢复后核心仍不完整，请检查镜像或手动重装 DSH" >&2
    fi
  elif [ -d "${CORE_DIR}" ]; then
    echo "[entrypoint] ❌ 活动核心目录存在但内容残缺，且无可用的完整回滚点；DSH 可能无法启动" >&2
  fi
fi

# 清理过期 staging/rollback 残留（>60 分钟），不触碰活动核心与受保护回滚点
find "${CORE_PARENT}" -maxdepth 1 -name ".dsh-staging-*" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${CORE_PARENT}" -maxdepth 1 -name ".dsh-rollback-*" ! -name ".dsh-rollback-preserved" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${DSH_VERSIONS_DIR}/.staging" -maxdepth 1 -mindepth 1 -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# 持久化自检
_persisted=0
while IFS= read -r _mp; do
  [ -z "$_mp" ] && continue
  [ "$_mp" = "/" ] && continue
  case "${DSH_VERSIONS_DIR}/" in "${_mp}/"*) _persisted=1; break ;; esac
done < <(awk '{print $5}' /proc/self/mountinfo 2>/dev/null)
if [ "$_persisted" != "1" ]; then
  echo "[entrypoint] ⚠️ 版本库 ${DSH_VERSIONS_DIR} 不在持久化挂载点内：容器重建后已归档版本将丢失。"
fi

# 2. 自动注册并同步插件到 DSH profile
if [ -f "/app/scripts/install-plugin.mjs" ]; then
  if [ "${DSH_VARIANT}" = "mini" ]; then
    echo "[entrypoint] 同步插件装配状态 (mini 变体)..."
  else
    echo "[entrypoint] 同步内置与预装插件到 Web Profile..."
  fi
  node /app/scripts/install-plugin.mjs || true
fi

# 3. 校验客户端与服务端补丁（优先只读 --verify；未命中时尝试幂等补打，失败显式告警但不阻断启动）
if [ -f "/app/scripts/patch-dsh-client.mjs" ]; then
  echo "[entrypoint] 校验 DSH 客户端与鉴权补丁状态..."
  if ! node /app/scripts/patch-dsh-client.mjs --verify; then
    echo "[entrypoint] ⚠️ 检测到补丁未就绪，尝试运行期幂等补打..."
    if ! node /app/scripts/patch-dsh-client.mjs; then
      echo "[entrypoint] ⚠️⚠️⚠️ 必需补丁未生效（详见上方 [FATAL] 行）！" >&2
      echo "[entrypoint] ⚠️ 服务仍会继续启动，但鉴权放行 / 回环 host 模式 / 插件包 404 自愈可能缺失。" >&2
    fi
  fi
fi

# 4. 启动统一网关守护循环
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

  if [ "$ran" -ge 60 ]; then
    attempt=0
    backoff=1
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "[entrypoint] ❌ 网关已连续退出 ${attempt} 次（最近退出码 ${code}，运行 ${ran}s），放弃重启并退出容器" >&2
    exit 1
  fi
  echo "[entrypoint] 网关进程已退出 (code=${code}，运行 ${ran}s)，${backoff}s 后重启（第 ${attempt} 次）..."
  sleep "$backoff"
  backoff=$(( backoff * 2 ))
  [ "$backoff" -gt 30 ] && backoff=30
done
