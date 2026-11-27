# 📝 更新日志 (Changelog)

> `0.x`（`v0.0.1` ~ `v0.2.16`）历史版本记录已归档保留于 `low` 分支，本文件自 `v1.0.0` 起重新起篇。

---

## [v1.0.0] - 2026-11-27

### 新增特性
- **全新 DSH 同源 Web Admin 控制台**：对齐官方 DSH 视觉与交互规范，内置 8 种界面语言（`zh` / `en` / `ja` / `es` / `fr` / `de` / `ru` / `pt`）与浅色 / 深色 / 跟随系统 / 跟随 DSH 主题切换，首屏无闪烁渲染。
- **四档镜像变体体系 (`standard` / `market` / `full` / `mini`)**：
  - `standard`（`:latest`，约 `3.85 GB`）：基于 `node:24.22.3-trixie-slim`，内置 Chromium/noVNC 桌面与 `gh` CLI，不预装社区插件与 Golang；
  - `market`（`:latest-market`，约 `3.87 GB`）：同 `trixie-slim` 底座与桌面栈，预装 `dshmarket` 与 `@hytime/dsh-thinking-effort`；
  - `full`（`:latest-full` + `docker-compose.full.yml`，约 `5.41 GB`）：基于全量 `node:24.22.3-trixie`（含 `gcc`/`g++`/`make` C/C++ 编译链），同时预装官方 Golang SDK、社区插件市场与完整桌面栈；
  - `mini`（`:latest-mini`，约 `2.39 GB`）：移除桌面栈、Golang 与 `gh`，提供 `linux/amd64` + `linux/arm64` 双架构。
- **预装社区插件双通道在线更新**：`market` 与 `full` 预装插件改为标准 npm 语义化版本范围（`^x.y.z`）注册并自动迁移旧卷 `link:` 引用，支持通过 `dshmarket` 应用商店或 DSH 自带插件管理一键在线更新，重启容器后保留已升级版本。
- **模块化网关、在线换源与原生压缩透传**：网关后端按职责模块化并引入多语言结构化错误码；管理后台支持在线切换并持久化 npm / pnpm 镜像源；移除代理层对 JS 资源的内存缓冲，恢复浏览器原生 `br` / `gzip` 流式压缩。
- **有界 `pigz` 多线程备份与长耗时抗断连**：快照打包与还原默认启用有界 `pigz` 多线程压缩（上限 8 核，支持 `DSH_BACKUP_THREADS` 配置）；超时统一联动 `DSH_SNAPSHOT_TIMEOUT_MS`（默认 30 分钟）；核心切换前备份改走异步轮询，快照还原遇反向代理 `502`/`504` 断连时自动轮询恢复。
- **非 root 与容器运行加固**：支持 `PUID` / `PGID` 自动修正数据卷属主后通过 `setpriv` 降权启动，以及 `user: "1001:1001"` 纯非 root 运行；配置文件不可读时进入 fail-closed `503` 安全锁止页；`HEALTHCHECK` 自动跟随 `PROXY_PORT`。

### 缺陷修复
- **代理与反代环境变量边界加固**：配置 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 时自动向 `NO_PROXY` 追加 `127.0.0.1,localhost,::1`，防止劫持容器内部回环通信；显式非空 `TRUST_PROXY` 与 `PUBLIC_HOST` 环境变量优先于持久化配置。
- **自定义 `DSH_HOME` 快照打包修复**：修复非 `/root` 路径下快照打包源目录错误，归档统一归一化为 `.dsh/` 前缀并收敛文件权限为 `0600`。
- **快照还原状态与内部令牌修复**：还原时保留运行期 `.internal-api-token`（修复还原后内部接口 `401`），合并 `plugins-state.json` 防止已卸载/停用插件复活，并自动重定位跨 `DSH_HOME` 绝对软链。
- **网关配置与桌面路径修复**：修复保存系统设置时丢失 `trustProxy` / `publicHost` 字段的问题，以及自定义 `VNC_PATH` 下静态资源与 WebSocket 前缀截取异常。

### 破坏性变更与升级说明
- **DSH 引擎基线收敛至 `>= 0.2.3-alpha.2`**：主线镜像与在线版本切换强制要求 `@deepseek-ai/dsh >= 0.2.3-alpha.2`，旧版引擎请使用 `low` 分支或固定拉取 `:v0.2.16` 系列归档镜像。
- **存量 `0.x` 数据卷无缝升级**：既有 `./data/dsh`、`./data/snapshots` 与 `./workspace` 可直接挂载启动，会话 Cookie、路径映射与历史 `.tar.gz` 快照（含早期 `settings.yaml` 格式）均保持兼容。
