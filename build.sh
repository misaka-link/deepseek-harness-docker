#!/bin/bash
set -e

# deepseek-harness 镜像构建工具
# 用法:
#   ./build.sh          -> 构建默认纯净基础镜像 (deepseek-harness-docker:latest)
#   ./build.sh --market -> 构建带预装插件清单的镜像 (deepseek-harness-docker:market)

IMAGE_NAME="deepseek-harness-docker"

if [ "$1" = "--market" ] || [ "$1" = "-m" ] || [ "$PREINSTALL_PLUGINS" = "1" ]; then
  echo "========================================================="
  echo " 构建包含预装插件清单的 Market 镜像: ${IMAGE_NAME}:market"
  echo " 预装清单参考: plugins.market.list"
  echo "========================================================="
  docker build \
    --build-arg PREINSTALL_PLUGINS=1 \
    -t "${IMAGE_NAME}:market" \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:market"
  echo ">>> 可使用 'docker compose -f docker-compose.market.yml up -d' 启动测试"
else
  echo "========================================================="
  echo " 构建默认基础镜像: ${IMAGE_NAME}:latest (默认不预装插件)"
  echo " 若需预装市场插件，请执行: ./build.sh --market"
  echo "========================================================="
  docker build \
    --build-arg PREINSTALL_PLUGINS=0 \
    -t "${IMAGE_NAME}:latest" \
    .
  echo ">>> 成功产出镜像: ${IMAGE_NAME}:latest"
  echo ">>> 可使用 'docker compose up -d' 启动测试"
fi
