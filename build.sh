#!/bin/bash
set -e

# deepseek-harness 镜像构建工具
# 用法:
#   ./build.sh          -> 构建默认纯净基础镜像 (deepseek-harness-docker:latest 及 dsh 核心版本标签)
#   ./build.sh --market -> 构建带预装插件清单的镜像 (deepseek-harness-docker:market 及 dsh 核心版本标签)

IMAGE_NAME="deepseek-harness-docker"
DSH_VERSION=$(curl -s https://registry.npmjs.org/@deepseek-ai/dsh/latest | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "0.1.2-rc.1")
[ -z "$DSH_VERSION" ] && DSH_VERSION="0.1.2-rc.1"

if [ "$1" = "--market" ] || [ "$1" = "-m" ] || [ "$PREINSTALL_PLUGINS" = "1" ]; then
  echo "========================================================="
  echo " 构建包含预装插件清单的 Market 镜像: ${IMAGE_NAME}:market"
  echo " 关联 DSH 核心版本标签: ${IMAGE_NAME}:dsh-${DSH_VERSION}-market"
  echo " 预装清单参考: plugins.market.list"
  echo "========================================================="
  docker build \
    --build-arg PREINSTALL_PLUGINS=1 \
    -t "${IMAGE_NAME}:market" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}-market" \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:market 与 ${IMAGE_NAME}:dsh-${DSH_VERSION}-market"
  echo ">>> 可使用 'docker compose -f docker-compose.market.yml up -d' 启动测试"
else
  echo "========================================================="
  echo " 构建默认基础镜像: ${IMAGE_NAME}:latest (默认不预装插件)"
  echo " 关联 DSH 核心版本标签: ${IMAGE_NAME}:dsh-${DSH_VERSION}"
  echo " 若需预装市场插件，请执行: ./build.sh --market"
  echo "========================================================="
  docker build \
    --build-arg PREINSTALL_PLUGINS=0 \
    -t "${IMAGE_NAME}:latest" \
    -t "${IMAGE_NAME}:dsh-${DSH_VERSION}" \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest 与 ${IMAGE_NAME}:dsh-${DSH_VERSION}"
  echo ">>> 可使用 'docker compose up -d' 启动测试"
fi
