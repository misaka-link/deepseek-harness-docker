# DeepSeek Harness Docker (Next-Gen)

> 🚀 **下一代 DeepSeek Harness 生产就绪型容器化套件**：集成**统一网关反代**、**DSH 亮色极简认证页**、**容器内 Chromium GUI 桌面与 VNC 反代**、**Web 管理控制台 (/admin)** 与 **DSH 配置文件快照备份恢复**，从底层根治供应商模型配置报错与回环网络限制。

---

## 🌟 项目核心亮点与功能特性

本项目深度吸取并升级了社区两大优秀项目（[`runzhliu/deepseek-harness-docker`](https://github.com/runzhliu/deepseek-harness-docker) 与 [`smanx/deepseek-harness-docker`](https://github.com/smanx/deepseek-harness-docker)）的长处，并彻底解决了它们的遗留缺陷：

| 核心维度 | 功能特性与实现 |
|---|---|
| **DSH 最新核心** | 预装官方最新 **`@deepseek-ai/dsh@0.1.2-rc.1`**，自动打捞 `launch-token` 并保持全量特权接口免 403 畅行 |
| **单端口同权反代** | DSH Web (`/`)、管理面板 (`/admin`) 与 noVNC 桌面 (`/vnc/`) 共享单端口；**统一经由认证码防护** |
| **DSH 亮色极简认证页** | 废除原生 Basic Auth 弹窗，采用与官方同源的高颜值亮色居中卡片，仅输入“认证码”即可免密通行 30 天 |
| **安全防御体系** | 内置 **防暴力破解频率限制 (5次锁定)**、**CSWSH 跨站 WebSocket 劫持拦截**、**防目录穿越规整** 与 **开放重定向白名单校验** |
| **浏览器桌面与 AI 控制** | 独立 Cordis 插件 (`dsh-browser-desktop`)：支持 AI 指定工作时长 (`durationMinutes`)、空闲超时自动休眠与唤醒、CDP 调试 |
| **Web 管理面板 (/admin)** | 在线浏览与切换 DSH 版本（支持 npmmirror/npmjs）、一键启停虚拟桌面、创建/还原/下载配置快照 |
| **默认初始快照 (幂等)** | 首次启动自动备份 `/root/.dsh` 初始配置快照，内置标记防重复生成，随时可一键还原出厂配置 |
| **自定义访问路径** | 允许通过环境变量自定义管理面板路径 (`ADMIN_PATH`) 与桌面路径 (`VNC_PATH`) |
| **存储卷彻底解耦** | `./data/dsh`(配置)、`./workspace`(独立项目代码)、`./data/snapshots`(快照库)、`./data/browser`(浏览器登录态) 分离挂载 |

---

## 📐 架构全景

```
                          [ 客户端浏览器 / 移动端 ]
                                      │
                              外部单个统一端口 (:3080)
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │                  dsh-gateway (网关)               │
             │                                                  │
             │  • DSH 亮色质感登录页 (/login)                   │
             │  • 认证码校验 (AUTH_TOKEN / Cookie / Strict)     │
             │  • 未授权拦截 (页面 302 重定向 / API 返回 401)   │
             │  • 防暴力破解频率限制 (连续5次错误锁定60s)       │
             │  • CSWSH 跨站 WebSocket 劫持防御                 │
             │  • 标头智能对齐 (消除 403 / 固化 Loopback)       │
             │  • 动态注入 crypto.randomUUID Polyfill           │
             └───────┬──────────────────┬─────────────────┬─────┘
                     │ 已认证通过       │ 已认证通过      │ 已认证通过
                     ▼                  ▼                 ▼
             ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
             │ DSH Web 核心  │  │ Web 管理后台  │  │  noVNC 桌面   │
             │   (/*)        │  │ (/admin/*)    │  │  (/vnc/*)     │
             │ • 127.0.0.1:  │  │ • 版本在线切换│  │ • 127.0.0.1:  │
             │   3079        │  │ • 配置快照备份│  │   6080        │
             │ • 工作区:     │  │ • 桌面启停控制│  │ • Chromium    │
             │   /workspace  │  │ • 还原与下载  │  │   (CDP: 9222) │
             └───────────────┘  └───────────────┘  └───────────────┘
```

---

## 🚀 快速开始

### 1. 配置环境变量
```bash
cp .env.example .env

# 编辑 .env，设置你的访问认证码与自定义路径 (可选)
# AUTH_TOKEN=admin
# ADMIN_PATH=/admin
# VNC_PATH=/vnc
```

### 2. 镜像获取与启动

#### 方式一：直接使用 GitHub Packages (GHCR) 预构建镜像（推荐，省时免编译）

本项目已配置 GitHub Actions 自动构建全套生产镜像，可直接拉取使用：

```bash
# 1. 基础纯净版 (不带商店，体积更轻)
docker pull ghcr.io/misaka-link/deepseek-harness-docker:latest
# 或指定版本号
# docker pull ghcr.io/misaka-link/deepseek-harness-docker:0.0.1

# 2. 社区市场版 (预装 dshmarket 商店与思考强度调节插件)
docker pull ghcr.io/misaka-link/deepseek-harness-docker:market
# 或指定版本号
# docker pull ghcr.io/misaka-link/deepseek-harness-docker:0.0.1-market
```

若直接使用 `docker-compose.yml`，只需将 `image` 改为对应 GHCR 地址并启动即可：
```bash
docker compose up -d
```

#### 方式二：本地自行构建镜像

本项目提供构建脚本 `./build.sh`，支持选择是否预装社区常用插件：

```bash
# 模式 A: 构建默认基础镜像 (不预装插件，产出 deepseek-harness-docker:latest)
./build.sh
docker compose up -d

# 模式 B: 构建预装应用市场插件的 Market 镜像 (产出 deepseek-harness-docker:market)
./build.sh --market
docker compose -f docker-compose.market.yml up -d
```

> 预装插件清单可在 `plugins.market.list` 中自定义编辑，默认包含：
> - [dsh-market](https://github.com/dsh-market/dsh-market) (DSH 社区应用市场)
> - [dsh-thinking-effort](https://github.com/hytime/dsh-thinking-effort#readme) (思考强度调节插件)

### 3. 打开浏览器访问
* **DSH Web 界面**：`http://<服务器IP>:3080/`
* **Web 管理面板**：`http://<服务器IP>:3080/admin/`
* **容器 Chromium 桌面 (VNC)**：`http://<服务器IP>:3080/vnc/`

> **提示**：输入环境变量配置的认证码（如 `admin`）即可一键进入。

---

## ⚙️ 环境变量速查

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | *(空)* | **访问认证码**。设置后生效；留空则直接关闭认证层无感直通 |
| `PROXY_PORT` | `3080` | 网关对外统一监听端口 (供 Docker 映射暴露) |
| `ADMIN_PATH` | `/admin` | **自定义管理后台路径** (例如可改为 `/my-admin`) |
| `VNC_PATH` | `/vnc` | **自定义桌面 VNC 路径** (例如可改为 `/desktop`) |
| `DSH_WORKSPACE` | `/workspace` | DSH 默认工作目录，新建会话与文件浏览器默认定位在此 |
| `DSH_DESKTOP_ENABLED` | `1` | 是否启用容器图形桌面 (1: 开启, 0: 关闭桌面仅纯命令模式) |
| `DSH_IDLE_TIMEOUT_MINUTES`| `30` | **浏览器桌面空闲休眠时间** (分钟，默认30，设为0则不休眠) |
| `DSH_DESKTOP_WIDTH` | `1440` | 虚拟显示器宽度分辨率 |
| `DSH_DESKTOP_HEIGHT` | `900` | 虚拟显示器高度分辨率 |
| `COOKIE_MAX_AGE` | `2592000` | 认证 Cookie 有效期（秒，默认 30 天免登录） |

---

## 📂 存储卷规划与隔离

| 挂载主机路径 | 容器内目标路径 | 作用说明 |
|---|---|---|
| `./data/dsh` | `/root/.dsh` | **DSH 系统配置**：包含已安装插件、用户 Presets、模型配置等 |
| `./workspace` | `/workspace` | **独立工作区**：包含 AI 生成的代码、项目文件，与 DSH 系统完全解耦 |
| `./data/snapshots` | `/root/.dsh-snapshots` | **配置快照库**：存储自动备份的初始默认快照与用户自建备份 |
| `./data/browser` | `/root/.config/chromium` | **浏览器持久化缓存**：保存 Chromium 网页登录状态与 Cookies |

---

## 🤖 AI 智能体控制浏览器示例

在 DSH 会话中，AI Agent 可直接使用注册的工具精确控制浏览器与工作时间：

1. **打开网页并保持工作指定时长**：
   ```json
   // 调用 browser_open 打开页面并保持工作 60 分钟后自动休眠
   { "url": "https://github.com", "durationMinutes": 60 }
   ```
2. **显式控制浏览器启停**：
   ```json
   // 调用 browser_control 停止浏览器以节约资源
   { "action": "stop" }
   // 或查询状态
   { "action": "status" }
   ```

---

## 🛠️ 项目目录结构

```
deepseek-harness-docker/
├── Dockerfile                  # 多阶段构建：精简系统 + 运行时工具 + Chromium + X11 + Node 环境
├── docker-compose.yml          # 开箱即用的容器编排配置
├── .env.example                # 环境变量配置模板
├── README.md                   # 项目使用与部署说明文档
├── scripts/
│   ├── entrypoint.sh           # 容器统一入口：启动网关与自动修补
│   ├── patch-dsh-client.mjs    # 客户端 bundle 固化补丁脚本 (根治 memory 模式与 loopback 限制)
│   └── chromium-docker         # Chromium 启动辅助脚本 (无沙箱安全标志与 CDP 端口绑定)
├── gateway/                    # 统一网关与管理中心
│   ├── package.json
│   ├── index.js                # 核心网关服务 (认证中间件 + DSH 反代 + VNC 反代 + Admin 路由)
│   ├── auth.js                 # 认证与安全加固 (Token 校验、防爆破限频、Strict Cookie)
│   ├── desktop-manager.js      # 桌面与 Chromium 进程动态启停、工作时长与休眠看门狗
│   ├── dsh-manager.js          # DSH 版本管理、在线切换、进程守护与快照备份还原
│   ├── token-crawler.js        # DSH 0.1.2+ launch-token 自动采集与会话桥接
│   └── public/
│       ├── login.html          # DSH 亮色极简风格认证界面
│       └── admin.html          # DSH 亮色质感 Web 管理控制台
└── plugins/
    └── dsh-browser-desktop/    # 独立且非侵入式的浏览器桌面插件
        ├── package.json
        ├── index.js            # 服务端：注册 browser_open 与 browser_control 工具，支持时长控制
        ├── client.js           # 客户端：注册轻量侧边栏 Slot 入口
        └── cordis.patch.yml    # Cordis 插件配置描述
```
