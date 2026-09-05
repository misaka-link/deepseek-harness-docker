# DeepSeek Harness Docker

生产就绪型 DeepSeek Harness 容器化套件。一键集成统一反向代理、高颜值访问认证、容器内真实 Chromium 浏览器桌面 (noVNC)、后台版本管理与备份控制台。简单来说：**Docker 一键梭哈，开箱即用。**

### 核心功能
- **统一单端口接入**：DSH Web、管理面板与 VNC 桌面共用 3080 端口，同一套密码统一鉴权。
- **免回环限制**：底层修复宿主配置持久化与模型配置，局域网/公网 IP 访问毫无障碍。
- **容器图形浏览器**：内置 Chromium、Xvfb、Openbox 与 noVNC，AI 可自主操控浏览器并截屏。
- **后台管理系统**：支持 DSH 核心版本一键热更新切换、插件市场管理、配置快照与备份还原。

---

## 📸 功能截图展示

| 登录访问认证 (默认口令: `admin`) | DSH Web 交互工作区 |
| :---: | :---: |
| ![登录界面](doc/01-login-auth.png) | ![DSH Web](doc/02-dsh-web.png) |

| 后台版本管理与热切换 (`/admin`) | 拓展与插件市场管理 |
| :---: | :---: |
| ![后台版本切换](doc/06-admin-tab-dsh.png) | ![插件管理](doc/07-admin-tab-plugins.png) |

| 浏览器桌面配置 | 容器内置 Chromium noVNC 桌面 (`/vnc/`) |
| :---: | :---: |
| ![浏览器配置](doc/08-admin-tab-desktop.png) | ![浏览器vnc](doc/11-vnc-desktop.png) |

| 配置快照与备份管理 | 网关与系统设置页面 |
| :---: | :---: |
| ![备份管理](doc/09-admin-tab-snapshots.png) | ![设置页面](doc/10-admin-tab-settings.png) |

---

## 🚀 Docker 一键梭哈

### 1. 单行命令极速启动 (推荐)

直接运行以下命令，拉取并启动容器：

```bash
docker run -d \
  --name deepseek-harness \
  --restart unless-stopped \
  -p 3080:3080 \
  -e AUTH_TOKEN=admin \
  -v $(pwd)/data/dsh:/root/.dsh \
  -v $(pwd)/workspace:/workspace \
  -v $(pwd)/data/snapshots:/root/.dsh-snapshots \
  -v $(pwd)/data/browser:/root/.config/chromium \
  ghcr.io/misaka-link/deepseek-harness-docker:latest
```

启动完成后直接访问：
- **DSH Web 界面**：`http://<你的服务器IP>:3080/`
- **后台管理面板**：`http://<你的服务器IP>:3080/admin/`
- **容器桌面 (noVNC)**：`http://<你的服务器IP>:3080/vnc/`
- **默认认证码**：`admin`

---

### 2. Docker 容器编排 (docker-compose)

新建 `docker-compose.yml` 文件：

```yaml
services:
  deepseek-harness:
    image: ghcr.io/misaka-link/deepseek-harness-docker:latest
    container_name: deepseek-harness
    restart: unless-stopped
    ports:
      - "3080:3080"
    environment:
      # 访问认证码（用于登录 Web、管理后台与 VNC 桌面，留空则免密放行）
      - AUTH_TOKEN=admin
      - PROXY_PORT=3080
    volumes:
      # DSH 配置与系统文件
      - ./data/dsh:/root/.dsh
      # 项目独立工作区
      - ./workspace:/workspace
      # 配置快照存档
      - ./data/snapshots:/root/.dsh-snapshots
      # 浏览器缓存目录
      - ./data/browser:/root/.config/chromium
```

一键启动：
```bash
docker compose up -d
```

停止或更新：
```bash
docker compose down && docker compose pull && docker compose up -d
```

---

## ⚙️ 常见环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | `admin` | 访问认证码（留空则不设密码，放行所有访问） |
| `PROXY_PORT` | `3080` | 容器统一对外暴露端口 |
| `ADMIN_PATH` | `/admin` | 管理后台自定义路径 |
| `VNC_PATH` | `/vnc` | noVNC 桌面自定义路径 |
| `DSH_WORKSPACE` | `/workspace` | DSH AI 默认项目工作区 |
| `DSH_DESKTOP_ENABLED` | `1` | 是否开启内置图形浏览器桌面 (1: 开启, 0: 关闭) |
| `DSH_DESKTOP_WIDTH` | `1920` | 虚拟桌面宽度分辨率 |
| `DSH_DESKTOP_HEIGHT` | `1080` | 虚拟桌面高度分辨率 |
