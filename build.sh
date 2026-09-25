#!/bin/bash
set -e

# deepseek-harness 镜像构建工具
# 用法:
#   ./build.sh          -> 构建默认纯净基础镜像 (deepseek-harness-docker:latest 及额外标签)
#   ./build.sh --market -> 构建带预装插件清单的镜像 (deepseek-harness-docker:latest-market 及额外标签)

IMAGE_NAME="deepseek-harness-docker"
PROJ_VER="0.1.9"
NODE_IMAGE="${NODE_IMAGE:-node:24-trixie}"
NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION:-1.6.0}"
# 预装层缓存刷新键：默认用当前时间戳，保证每次构建都重新执行预装层，
# 让 plugins.market.list 里的 @latest 插件（dshmarket）拉到最新版。
MARKET_REFRESH="${MARKET_REFRESH:-$(date +%s)}"
# ── M10 供应链固定 ───────────────────────────────────────────────
# 默认版本写死在 version.json#supply（不再每次构建都去 npm 拉"最新 alpha"，
# 避免同一次发布构建出不同内容的镜像）；确需升级时显式改 version.json 或用环境变量覆盖。
read_supply() {
  node -e "const v=require('./version.json').supply||{};process.stdout.write(String(v['$1']||''))" 2>/dev/null \
    || grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" version.json | head -1 | sed 's/.*:\(.*\)/\1/' | tr -d '", '
}
PINNED_DSH="$(read_supply dshVersion)"
PINNED_PNPM="$(read_supply pnpmVersion)"
DSH_VERSION="${DSH_VERSION:-${PINNED_DSH:-0.1.7-rc.2}}"
PNPM_VERSION="${PNPM_VERSION:-${PINNED_PNPM:-12.5.1}}"
echo " 供应链固定版本: DSH=${DSH_VERSION}  pnpm=${PNPM_VERSION}"
if [ -z "${DSH_VERSION}" ]; then echo "错误: 未能确定 DSH 版本" >&2; exit 1; fi

if [ "$1" = "--market" ] || [ "$1" = "-m" ] || [ "$PREINSTALL_PLUGINS" = "1" ]; then
  echo "========================================================="
  echo " 构建包含预装插件清单的 Market 镜像: ${IMAGE_NAME}:latest-market"
  echo " 底座镜像 (Node/OS): ${NODE_IMAGE}"
  echo " 关联额外标签一(DSH版本): ${IMAGE_NAME}:${DSH_VERSION}-market"
  echo " 关联额外标签二(项目版本): ${IMAGE_NAME}:${PROJ_VER}-market"
  echo " 预装清单参考: plugins.market.list"
  echo "========================================================="
  docker build \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=1 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    -t "${IMAGE_NAME}:latest-market" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest-market" \
    -t "${IMAGE_NAME}:market" \
    -t "${IMAGE_NAME}:${DSH_VERSION}-market" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}-market" \
    -t "${IMAGE_NAME}:${PROJ_VER}-market" \
    -t "${IMAGE_NAME}:v${PROJ_VER}-market" \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest-market (附加 DSH:${DSH_VERSION}-market 与 项目:${PROJ_VER}-market)"
  echo ">>> 可使用 'docker compose -f docker-compose.market.yml up -d' 启动测试"
else
  echo "========================================================="
  echo " 构建默认基础镜像: ${IMAGE_NAME}:latest (默认不预装插件)"
  echo " 底座镜像 (Node/OS): ${NODE_IMAGE}"
  echo " 关联额外标签一(DSH版本): ${IMAGE_NAME}:${DSH_VERSION}"
  echo " 关联额外标签二(项目版本): ${IMAGE_NAME}:${PROJ_VER}"
  echo " 若需预装市场插件，请执行: ./build.sh --market"
  echo "========================================================="
  docker build \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg NOVNC_ASSET_REVISION="${NOVNC_ASSET_REVISION}" \
    --build-arg PREINSTALL_PLUGINS=0 \
    --build-arg DSH_VERSION="${DSH_VERSION}" \
    --build-arg PNPM_VERSION="${PNPM_VERSION}" \
    --build-arg MARKET_REFRESH="${MARKET_REFRESH}" \
    -t "${IMAGE_NAME}:latest" \
    -t "ghcr.io/misaka-link/${IMAGE_NAME}:latest" \
    -t "${IMAGE_NAME}:${DSH_VERSION}" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}" \
    -t "${IMAGE_NAME}:${PROJ_VER}" \
    -t "${IMAGE_NAME}:v${PROJ_VER}" \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest (附加 DSH:${DSH_VERSION} 与 项目:${PROJ_VER})"
  echo ">>> 可使用 'docker compose up -d' 启动测试"
fi
