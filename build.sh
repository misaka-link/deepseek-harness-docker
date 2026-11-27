#!/bin/bash
set -e

# deepseek-harness 镜像构建工具 (4-Tier: standard / market / full / mini)
# 用法:
#   ./build.sh          -> 构建默认标准版镜像 (deepseek-harness-docker:latest / :standard，trixie-slim + 桌面/Chromium + gh，不含 Golang 与市场插件)
#   ./build.sh --market -> 构建插件商店版镜像 (deepseek-harness-docker:latest-market，同标准版底座 + 预装 plugins.market.list)
#   ./build.sh --full   -> 构建完全体镜像 (deepseek-harness-docker:latest-full，trixie 全量底座含 C/C++ 编译链 + Golang + 预装插件 + 完整桌面)
#   ./build.sh --mini   -> 构建轻量精简镜像 (deepseek-harness-docker:latest-mini，无 Chromium/桌面/Golang/gh，C 档瘦身)
#   可选参数:
#     --arch amd64|arm64|both (both 使用 docker buildx 构建多架构 manifest，必须配合 --push)
#     --push  构建后推送到 registry（多架构 manifest 无法 load 到本地，必须推送）

# 允许用环境变量覆盖：测试构建若靠 sed 改这一行，同步仓库时会被覆盖回默认值，
# 结果把测试镜像打成了生产名字（实际踩过）。IMAGE_NAME=dsh-i18test ./build.sh 更安全。
IMAGE_NAME="${IMAGE_NAME:-deepseek-harness-docker}"
PROJ_VER="1.0.0"
NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
# 预装层缓存刷新键：默认用当前时间戳，保证每次构建都重新执行预装层，
# 让 plugins.market.list 里的 @latest 插件（dshmarket）拉到最新版。
MARKET_REFRESH="${MARKET_REFRESH:-$(date +%s)}"

# ── 供应链版本固定 ───────────────────────────────────────────────
# 默认版本固定在 version.json#supply，保证同一次发布构建出可复现的镜像；
# 确需升级时显式修改 version.json 或通过环境变量覆盖。
read_supply() {
  node -e "const v=require('./version.json').supply||{};process.stdout.write(String(v['$1']||''))" 2>/dev/null \
    || grep -o "\"\$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" version.json | head -1 | sed 's/.*:\(.*\)/\1/' | tr -d '", '
}
PINNED_DSH="$(read_supply dshVersion)"
PINNED_PNPM="$(read_supply pnpmVersion)"
PINNED_INTEG="$(read_supply dshIntegrity)"
DSH_VERSION="${DSH_VERSION:-${PINNED_DSH:-0.2.3-alpha.2}}"
PNPM_VERSION="${PNPM_VERSION:-${PINNED_PNPM:-12.5.1}}"
DSH_INTEGRITY="${DSH_INTEGRITY:-${PINNED_INTEG}}"
echo " 供应链固定版本: DSH=${DSH_VERSION}  pnpm=${PNPM_VERSION}"
if [ -z "${DSH_VERSION}" ]; then echo "错误: 未能确定 DSH 版本" >&2; exit 1; fi

# ── 参数解析（4-Tier 变体与架构）─────────────────────────────────
VARIANT=""
ARCH_TARGET=""
PUSH_FLAG=""

set_variant() {
  if [ -n "$VARIANT" ] && [ "$VARIANT" != "$1" ]; then
    echo "错误: 变体参数互斥（已指定 --${VARIANT}，不可同时指定 --$1）" >&2
    exit 2
  fi
  VARIANT="$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --standard)
      set_variant "standard"
      ;;
    --market|-m)
      set_variant "market"
      ;;
    --full|-f)
      set_variant "full"
      ;;
    --mini)
      set_variant "mini"
      ;;
    --arch)
      shift
      ARCH_TARGET="$1"
      ;;
    --arch=*)
      ARCH_TARGET="${1#*=}"
      ;;
    --push)
      PUSH_FLAG="1"
      ;;
    *)
      echo "未知参数: $1" >&2
      echo "用法: ./build.sh [--standard | --market | --full | --mini] [--arch amd64|arm64|both] [--push]" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -z "$VARIANT" ]; then
  VARIANT="standard"
fi

# 互斥检查与环境变量兼容
if [ "${PREINSTALL_PLUGINS:-}" = "1" ] && [ "$VARIANT" = "mini" ]; then
  echo "错误: --mini 与 PREINSTALL_PLUGINS=1 互斥" >&2
  exit 2
fi
if [ "$VARIANT" = "standard" ] && [ "${PREINSTALL_PLUGINS:-}" = "1" ]; then
  VARIANT="market"
fi

# 架构校验
if [ -n "$ARCH_TARGET" ]; then
  case "$ARCH_TARGET" in
    amd64|arm64|both) ;;
    *)
      echo "错误: 不支持的架构参数 '${ARCH_TARGET}'，支持: amd64 | arm64 | both" >&2
      exit 1
      ;;
  esac
fi

# 构建底座确定：仅 full 采用全量 trixie（含 buildpack-deps C/C++ 编译链），其余变体采用 trixie-slim
if [ "$VARIANT" = "full" ]; then
  DEFAULT_NODE_IMAGE="node:24.22.3-trixie"
else
  DEFAULT_NODE_IMAGE="node:24.22.3-trixie-slim"
fi
NODE_IMAGE="${NODE_IMAGE:-$DEFAULT_NODE_IMAGE}"

# 构建命令构建
BUILD_CMD="docker build"
if [ "$ARCH_TARGET" = "both" ]; then
  # 多架构 manifest 无法 --load 到本地 docker，必须推送到 registry（CI 即走这条路径）
  if [ "$PUSH_FLAG" != "1" ]; then
    echo "错误: --arch both 必须同时指定 --push（多架构 manifest 不能加载到本地）" >&2
    echo "      本地单架构请用 --arch amd64 或 --arch arm64；多架构发布请用 --push，或交给 GitHub Actions" >&2
    exit 2
  fi
  BUILD_CMD="docker buildx build --platform linux/amd64,linux/arm64 --push"
elif [ -n "$ARCH_TARGET" ]; then
  if [ "$PUSH_FLAG" = "1" ]; then
    BUILD_CMD="docker buildx build --platform linux/${ARCH_TARGET} --push"
  else
    BUILD_CMD="docker build --platform linux/${ARCH_TARGET}"
  fi
fi

# ── 追加镜像标签（Issue #9）─────────────────────────────────────
# 用途：为特定问题 / 特定用户单独构建测试镜像，不影响 :latest 与正式发布标签。
# 用法：EXTRA_TAGS="issue9-fix" ./build.sh
#       EXTRA_TAGS="issue9-fix-market" ./build.sh --market
#       EXTRA_TAGS="issue9-fix-full" ./build.sh --full
#       EXTRA_TAGS="issue9-fix-mini" ./build.sh --mini
# 多个标签用空格分隔；每个标签同时打本地名与 ghcr.io 名。
EXTRA_TAGS="${EXTRA_TAGS:-}"
EXTRA_TAG_ARGS=""
for _t in ${EXTRA_TAGS}; do
  EXTRA_TAG_ARGS="${EXTRA_TAG_ARGS} -t ${IMAGE_NAME}:${_t} -t ghcr.io/misaka-link/${IMAGE_NAME}:${_t}"
  echo " 追加标签: ${IMAGE_NAME}:${_t}  /  ghcr.io/misaka-link/${IMAGE_NAME}:${_t}"
done

INTEGRITY_ARGS=""
if [ -n "${DSH_INTEGRITY}" ]; then
  INTEGRITY_ARGS="--build-arg DSH_INTEGRITY=${DSH_INTEGRITY}"
fi

if [ "$VARIANT" = "mini" ]; then
  echo "========================================================="
  echo " 构建轻量精简 Mini 镜像 (C 档瘦身): ${IMAGE_NAME}:latest-mini"
  echo " 底座镜像 (Node/OS): ${NODE_IMAGE}"
  echo " 架构目标: ${ARCH_TARGET:-默认架构}"
  echo " 关联额外标签一(DSH版本): ${IMAGE_NAME}:${DSH_VERSION}-mini"
  echo " 关联额外标签二(项目版本): ${IMAGE_NAME}:${PROJ_VER}-mini"
  echo " 特性: 无 Chromium / 无 X11桌面 / 无 Golang / 无 gh / 瘦身运行依赖"
  echo "========================================================="
  ${BUILD_CMD} \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg VARIANT=mini \
    --build-arg INSTALL_DESKTOP=0 \
    --build-arg INSTALL_GO=0 \
    --build-arg PRUNE_LEVEL=mini \
    --build-arg PREINSTALL_PLUGINS=0 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg SUITE_VERSION="${PROJ_VER}" \
    ${INTEGRITY_ARGS} \
    -t "${IMAGE_NAME}:latest-mini" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest-mini" \
    -t "${IMAGE_NAME}:mini" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:mini" \
    -t "${IMAGE_NAME}:${DSH_VERSION}-mini" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${DSH_VERSION}-mini" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}-mini" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:dsh-${DSH_VERSION}-mini" \
    -t "${IMAGE_NAME}:${PROJ_VER}-mini" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${PROJ_VER}-mini" \
    -t "${IMAGE_NAME}:v${PROJ_VER}-mini" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:v${PROJ_VER}-mini" \
    ${EXTRA_TAG_ARGS} \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest-mini (附加 DSH:${DSH_VERSION}-mini 与 项目:${PROJ_VER}-mini)"
  echo ">>> 可使用 'docker compose -f docker-compose.mini.yml up -d' 启动测试"
elif [ "$VARIANT" = "market" ]; then
  echo "========================================================="
  echo " 构建插件商店版 Market 镜像: ${IMAGE_NAME}:latest-market"
  echo " 底座镜像 (Node/OS): ${NODE_IMAGE}"
  echo " 架构目标: ${ARCH_TARGET:-默认架构}"
  echo " 关联额外标签一(DSH版本): ${IMAGE_NAME}:${DSH_VERSION}-market"
  echo " 关联额外标签二(项目版本): ${IMAGE_NAME}:${PROJ_VER}-market"
  echo " 特性: slim 底座 + 完整桌面/Chromium + gh + 预装社区插件 (无 Golang)"
  echo " 预装清单参考: plugins.market.list"
  echo "========================================================="
  ${BUILD_CMD} \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg VARIANT=market \
    --build-arg INSTALL_DESKTOP=1 \
    --build-arg INSTALL_GO=0 \
    --build-arg PRUNE_LEVEL=full \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=1 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg SUITE_VERSION="${PROJ_VER}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    ${INTEGRITY_ARGS} \
    -t "${IMAGE_NAME}:latest-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest-market" \
    -t "${IMAGE_NAME}:market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:market" \
    -t "${IMAGE_NAME}:${DSH_VERSION}-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${DSH_VERSION}-market" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:dsh-${DSH_VERSION}-market" \
    -t "${IMAGE_NAME}:${PROJ_VER}-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${PROJ_VER}-market" \
    -t "${IMAGE_NAME}:v${PROJ_VER}-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:v${PROJ_VER}-market" \
    ${EXTRA_TAG_ARGS} \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest-market (附加 DSH:${DSH_VERSION}-market 与 项目:${PROJ_VER}-market)"
  echo ">>> 可使用 'docker compose -f docker-compose.market.yml up -d' 启动测试"
elif [ "$VARIANT" = "full" ]; then
  echo "========================================================="
  echo " 构建完全体 Full 镜像: ${IMAGE_NAME}:latest-full"
  echo " 底座镜像 (Node/OS): ${NODE_IMAGE}"
  echo " 架构目标: ${ARCH_TARGET:-默认架构}"
  echo " 关联额外标签一(DSH版本): ${IMAGE_NAME}:${DSH_VERSION}-full"
  echo " 关联额外标签二(项目版本): ${IMAGE_NAME}:${PROJ_VER}-full"
  echo " 特性: 全量 trixie (C/C++编译链) + Golang SDK + 完整桌面/Chromium + gh + 预装社区插件"
  echo "========================================================="
  ${BUILD_CMD} \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg VARIANT=full \
    --build-arg INSTALL_DESKTOP=1 \
    --build-arg INSTALL_GO=1 \
    --build-arg PRUNE_LEVEL=full \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=1 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg SUITE_VERSION="${PROJ_VER}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    ${INTEGRITY_ARGS} \
    -t "${IMAGE_NAME}:latest-full" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest-full" \
    -t "${IMAGE_NAME}:full" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:full" \
    -t "${IMAGE_NAME}:${DSH_VERSION}-full" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${DSH_VERSION}-full" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}-full" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:dsh-${DSH_VERSION}-full" \
    -t "${IMAGE_NAME}:${PROJ_VER}-full" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${PROJ_VER}-full" \
    -t "${IMAGE_NAME}:v${PROJ_VER}-full" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:v${PROJ_VER}-full" \
    ${EXTRA_TAG_ARGS} \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest-full (附加 DSH:${DSH_VERSION}-full 与 项目:${PROJ_VER}-full)"
  echo ">>> 可使用 'docker compose -f docker-compose.full.yml up -d' 启动测试"
else
  echo "========================================================="
  echo " 构建默认标准版镜像: ${IMAGE_NAME}:latest (trixie-slim + 桌面/Chromium + gh，无 Go/预装插件)"
  echo " 底座镜像 (Node/OS): ${NODE_IMAGE}"
  echo " 架构目标: ${ARCH_TARGET:-默认架构}"
  echo " 关联额外标签一(DSH版本): ${IMAGE_NAME}:${DSH_VERSION}"
  echo " 关联额外标签二(项目版本): ${IMAGE_NAME}:${PROJ_VER}"
  echo " 其他变体: ./build.sh --market | ./build.sh --full | ./build.sh --mini"
  echo "========================================================="
  ${BUILD_CMD} \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg VARIANT=standard \
    --build-arg INSTALL_DESKTOP=1 \
    --build-arg INSTALL_GO=0 \
    --build-arg PRUNE_LEVEL=full \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=0 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg SUITE_VERSION="${PROJ_VER}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    ${INTEGRITY_ARGS} \
    -t "${IMAGE_NAME}:latest" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest" \
    -t "${IMAGE_NAME}:standard" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:standard" \
    -t "${IMAGE_NAME}:latest-standard" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest-standard" \
    -t "${IMAGE_NAME}:${DSH_VERSION}" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${DSH_VERSION}" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:dsh-${DSH_VERSION}" \
    -t "${IMAGE_NAME}:${PROJ_VER}" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:${PROJ_VER}" \
    -t "${IMAGE_NAME}:v${PROJ_VER}" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:v${PROJ_VER}" \
    ${EXTRA_TAG_ARGS} \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest (附加 :standard / DSH:${DSH_VERSION} / 项目:${PROJ_VER})"
  echo ">>> 可使用 'docker compose up -d' 启动测试"
fi
