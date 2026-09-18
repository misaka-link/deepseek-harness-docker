# 📝 更新日志 (Changelog)

所有关键版本演进、重要修复与架构变更均记录于此。

---

## [v0.1.2] - 2026-09-18

### 控制台与交互升级 (Admin UI & Issue #3)
- 🎛️ **Web Admin 顶部栏双版本清晰矩阵与 5 级安全态势预警体系 (落实 Issue #3)**：
  - **双版本解耦展示**：彻底废除单一模糊的 `v...` 徽标，划分为独立的【容器套件版本: `v0.1.2`】与【DSH 核心版本: `v0.1.6-alpha.2`】，解决概念混淆；
  - **Issue #3 快速跳转直达**：顶部栏与版本看板新增常驻直达按钮，一键快速跳转至官方 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库及本项目 [misaka-link/deepseek-harness-docker](https://github.com/misaka-link/deepseek-harness-docker) 仓库查看最新 Release Notes 与 Changelog 说明；
  - **5 级预设安全态势色彩矩阵**：设计 `success` (绿色正常/最新)、`info` (蓝色发现新版)、`warning` (黄色待适配/降级风险)、`danger` (绯红双重呼吸脉冲高亮/底层协议破坏/不再兼容)、`neutral` (中性灰离线) 预警机制；
  - **专有版本元数据与多通道容灾 (`version.json`)**：在仓库根目录建立程序专用元数据，免去 GitHub REST API 速率限制，通过全球 Anycast CDN (jsDelivr) + 官方 Raw + 镜像源多通道实现国内极速直达；
  - **版本与更新控制中心**：点击顶部栏徽章随时呼出版本详情弹窗，分栏对比本地与远端最新版本及 Changelog 摘要；
  - **破坏性版本切换红线防护**：在版本切换弹窗中对命中 `danger` 级别的破坏性版本进行红色高亮警告，防止错误在线热切换导致服务崩溃。

### 核心引擎适配 (DSH Engine Adaptation)
- 🌟 **全面适配官方最新引擎 (`@deepseek-ai/dsh@0.1.6-alpha.2`)**：
  - **插件管理页与运行时依赖解析**：全面适配官方新增的 Web 侧边栏“插件管理页”，支持直观查看、实时启用/禁用 profile 插件，以及通过官方 `@deepseek-ai/dsh-plugin-manager` 借助内置 pnpm 进行插件组合包（Bundle）的持久化安装与卸载；适配最新的运行时模块解析机制（Runtime Resolution）；
  - **侧边栏 Office 文档原生预览**：深度兼容官方引入的 `@deepseek-ai/dsh-office-to-pdf` 模块，无需宿主安装庞大的外部 Office 软件，基于独立 WASM 引擎在右侧边栏直接预览 Word (`.docx`)、Excel (`.xlsx`)、PowerPoint (`.pptx`) 文件；结合容器内预装的中文字体库（文泉驿、Noto CJK）实现排版保真渲染；
  - **会话回合文件变更卡片与 Diff 审阅**：全面兼容回合结束时生成的文件改动卡片与右侧边栏 Review Tab 逐文件代码对比功能；
  - **侧边栏内嵌 Web 浏览器**：兼容官方右侧边栏沙箱浏览器 (`ui-sidebar-browser`)，可与本容器专属的 Chromium + noVNC 真实桌面工具插件 (`dsh-browser-desktop`) 各司其职、互补共存；
  - **侧边栏 Subagent 会话与计划预览**：无缝支持官方在侧边栏直接展开子代理会话流与执行计划卡片；
  - **默认模型列表对齐**：对齐官方移除过时的 V4 Flash / V4 Flash Vision Exp 默认条目，保持对 `DeepSeek-V41-Flash` (`deepseek-flash`) 与 `DeepSeek-V4-Pro` (`deepseek-v4-pro`) 的原生支持。

### 基础设施与管理升级 (Infrastructure & Admin)
- 🔄 **管理后台与 CI 探测链同步升级**：
  - 升级 `gateway/dsh-manager.js` 与 `gateway/public/admin.html`，置顶推荐 `0.1.6-alpha.2`，平滑向下兼容 `0.1.6-alpha.1`、`0.1.5-rc.2`、`0.1.5-rc.1` 与 `0.1.2-rc.1`；
  - 同步更新本地构建脚本 `build.sh`、CI 构建流 `.github/workflows/docker-build.yml` 及工程版本号至 `0.1.2`。

---

## [v0.1.1] - 2026-09-15

### 安全加固 (Security)
- 🛡️ **全面防御开放重定向漏洞**：重构登录跳转逻辑，采用 WHATWG URL 规范严格校验目标协议与 Origin，杜绝制表符 `%09`、空白字符与 `//` / `/\\` 变体绕过；
- 🛡️ **根治 DOM 与存储型 XSS 漏洞**：
  - 重构管理面板快照列表渲染逻辑，使用 DOM 原生安全 API (`textContent` / `addEventListener`) 替代 `innerHTML` 拼接；
  - 重构插件管理表格按钮，改用 `data-plugin-name` 与事件委托机制，彻底根治 HTML 属性内联执行与转义失效漏洞；
  - 修复配置保存提示弹窗直接拼接新路由导致的 DOM XSS 风险；
- 🛡️ **修复插件卸载越界路径删除隐患**：引入插件名 npm 规范严格白名单，并在删除目标目录前增加严格的沙箱作用域路径边界校验，阻断恶意路径穿越删除宿主配置；
- 🛡️ **截图工具工作区沙箱隔离**：`browser_screenshot` 新增工作区路径约束，强制将保存路径限制在当前会话工作区范围内，杜绝通过 Prompt Injection 越界覆写宿主敏感文件；
- 🛡️ **敏感口令多重脱敏防护**：
  - 管理接口 `/api/status` 不再向前端明文返回实际 `authToken`，采用掩码回显并增加“清除口令”安全开关；
  - 快照备份打包时自动排除包含明文口令的 `gateway.config.json`；
  - 网关日志在打印新配置提交时主动对口令进行掩码脱敏。

### 架构与核心优化 (Architecture & Core)
- 🌐 **CI/CD 发布链路与构建版本闭环**：
  - 修复 GitHub Actions 触发器配置，补齐 Git Tag 与 Main 分支版本推送自动化触发；
  - 对齐 CI 与本地 `build.sh` 的 DSH 探测优先级策略，统一优先拉取最新 `alpha` 适配核心（`0.1.6-alpha.1`）；
- 🌿 **彻底剥离 `NODE_ENV=production` 环境渗透**：网关拉起 DSH 时显式剥离环境变量，恢复工作区纯净开发环境，避免用户执行包安装时默认跳过 `devDependencies`；
- ⚡ **事件循环单线程非阻塞重构**：
  - 重构后台版本探针逻辑，优先采用原生异步 `fetch` 请求 npm registry，并在网络异常时提供非阻塞异步回退，避免同步阻塞主线程；
  - 重构 `getCurrentVersion()` 为零开销内存缓存与文件轻量读取，彻底杜绝每 8 秒轮询同步派生子进程引发的网关卡顿；
  - 修复 `readJsonBody()` 在请求体超限时 Promise 悬挂与请求悬挂泄漏问题；
- 🔄 **系统网络自愈与多端端口一致性**：
  - 底座补齐 `iproute2` 工具链，并在端口释放探针中引入 Node.js 原生端口绑定探活双重兜底，使自愈释放机制真实闭环；
  - 修复网关实际监听端口向子进程环境与插件端的动态同步，修复 websockify 与备份服务中的硬编码端口冲突。

### 桌面与交互体验 (Desktop & UI)
- 🖥️ **虚拟桌面并发锁与 FD 资源回收**：
  - `desktop-manager` 新增启动互斥锁，多请求并发唤醒时复用同一启动任务，避免重复启动冲突与孤儿进程；
  - 虚拟桌面进程派生后立即在父进程关闭日志文件描述符，彻底根治多次切分辨率与休眠导致的 FD 持续累积泄漏；
  - 剥离 Chromium 启动脚本中硬编码的 9222 调试端口，恢复后台对 CDP 远程调试开关与端口的真实控制；
- 🎨 **管理后台表单交互闭环**：
  - 修复后台 8 秒状态轮询在用户输入时无条件覆写表单的问题；
  - 修复桌面控制面板中虚拟分辨率与休眠时间的准确回填；
  - 新增解耦的管理通信路由 `/__api/desktop/status`，避免客户端插件因自定义 `ADMIN_PATH` 导致 404；
  - 插件配置 `enabled` 开关真实生效，禁用时隐藏 SystemPrompt 并拦截工具调用；
- 🩹 **补丁注入脚本非破坏性重构**：重构 `patch-dsh-client.mjs` 函数替换机制，采用非破坏性重命名策略，彻底杜绝代码语法错误；重构 `cordis.patch.yml` 条目清理为结构化过滤，避免误伤相邻插件。

---

## [v0.1.0] - 2026-09-15

### 适配与升级
- 🌟 **全面适配官方最新引擎 (`@deepseek-ai/dsh@0.1.6-alpha.1`)**：
  - 深度支持 Web 侧边栏终端（多标签、Shell 选择与刷新自恢复）；
  - 支持官方新增的已归档会话（Archived Sessions）查看与一键恢复功能；
  - 适配官方 MCP SDK v2 升级与资源发现机制；
  - 适配 DeepSeek 默认 Messages 协议与 Files API 图片复用；
  - 适配沙箱化 PTC 与 `workflow-ptc` 架构升级；
  - 完美适配 `0.1.6-alpha.1` 宿主模式与回环持久化补丁，彻底杜绝设置项 403 与内存临时模式降级；
  - 升级动态探测链：优先探测 `alpha` 预发布标签，平滑向下兼容 `0.1.5-rc.2`、`0.1.5-rc.1` 与 `0.1.2-rc.1`；
  - 管理后台与版本管理列表默认置顶支持 `0.1.6-alpha.1`。

---

## [v0.0.9] - 2026-09-14

### 新增与优化
> 💡 本次更新参考借鉴了 [runzhliu/deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker) 项目的优秀实践。

- 🎛️ **Web Admin 后台核心版本看板与安全切换体系**：
  - 新增核心版本三栏状态看板（当前运行状态/端口/PID、官方最新 upstream 探测、快照与熔断保障）；
  - 新增核心版本切换多阶段实时进度条（快照备份 → 安装编译 → 软链重建 → 就绪探针）；
  - 新增版本切换安全防呆模态弹窗，集成切换前秒级自动快照备份与 V3 格式不可逆降级安全告警；
  - 增强端口独占自愈释放与进程残留清理，彻底杜绝版本切换时孤儿进程占用端口冲突。
- 🌟 **彻底移除全局 `NODE_ENV=production`**：改为在网关服务启动时局部注入，彻底解决工作区安装 `devDependencies` 被跳过的问题，恢复纯净开发环境；
- ⚡ **noVNC 静态资产版本化隔离与缓存击穿**：静态资源路径版本化并注入防强缓存响应头，彻底根治镜像升级后浏览器强缓存导致的白屏与报错；
- 🛠️ **升级基座底座为 Debian Trixie (glibc 2.41) & Node 24**：底层升级为 glibc 2.41 解决预编译二进制依赖兼容，补齐实用开发 CLI 工具链，并内置 Docker Desktop WSL2 路径兼容 Shim。

---

## [v0.0.8] - 2026-09-08

### 修复与改进
- 📸 **修复浏览器截图工具默认保存路径，彻底杜绝污染根目录 (`browser_screenshot`)**：
  - 修复 `dsh-browser-desktop` 插件中硬编码 `process.cwd()` 导致截图直接保存至容器 `/workspace` 根目录的缺陷；
  - 接入工具执行上下文 `exec`，将截图保存基准路径严格绑定到当前会话/项目自身的工作区目录（`exec.agent.session.header.cwd`）；
  - 相对路径及自动生成的唯一时间戳截图统一保存到项目自身目录（或配置的子目录下），不再平铺污染最外层宿主根目录；
  - 插件配置新增 `screenshotDir` 选项，支持用户在设置中心自由定义截图默认归档子文件夹（如 `screenshots`）。

---

## [v0.0.7] - 2026-09-07

### 适配与构建
- 🌟 **适配官方最新微调候选版 (`@deepseek-ai/dsh@0.1.5-rc.2`)**：
  - 自动检测并优先支持官方最新发布的 `0.1.5-rc.2`（包含反馈弹窗体验优化、交付文件卡片紧凑排版与代码文件新图标）；
  - `build.sh` 与 GitHub Actions CI 升级为 `next`/`latest` 双重动态探测，支持 `--build-arg DSH_VERSION` 自由定制；
  - 保持对 `0.1.5-rc.1` 与 `0.1.2-rc.1` 的平滑兼容。

---

## [v0.0.6] - 2026-09-06

### 新增特性与架构适配
- 🌟 **全面适配官方最新 RC 版本 (`@deepseek-ai/dsh@0.1.5-rc.1`)**：
  - 支持官方新增模型 `DeepSeek-V41-Flash` (`deepseek-flash`) 与动态系统提示词；
  - 原生支持出站代理继承：透传 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`，解决内网/私有化部署下模型 API 访问代理需求；
  - 适配官方 V3 会话格式：在管理后台与网关生命周期管理（`dsh-manager.js`）中加入版本升降级安全警告，强化升级前秒级快照备份，避免不可逆降级导致历史会话无法读取；
  - 增强 `install-plugin.mjs` 插件安装与软链接机制，兼容 npm 11 扁平化与嵌套依赖树。
- 🖥️ **右侧边栏（Right Sidebar）内嵌桌面 Tab 支持与设置开关**：
  - 深度融合官方 0.1.5-rc.1 全新推出的右侧 Sidebar 架构；
  - 在 `dsh-browser-desktop` 插件设置中心增加开关：**“在右侧边栏嵌入桌面 Tab (实验性)”**，**默认关闭**；
  - 开启后，可在 Web 界面右侧直接内嵌 noVNC 浏览器桌面，实现左侧对话/右侧操作浏览器的分栏并排工作流；
  - 运行时特性检测与向后兼容：在旧版本 DSH（无右侧边栏）下自动优雅降级，确保零错误。

---

## [v0.0.5] - 2026-09-05

### 核心重构与工具升级
- 🚀 **新增 AI 浏览器标签页全生命周期管理 (`browser_control`)**：
  - 新增 `close_tab` 动作：支持根据 `tabId` 靶向关闭特定标签页；未传时默认关闭当前工作页；
  - 新增 `close_all_tabs` 动作：一键关闭所有业务标签页，并安全重置为纯净的 `about:blank` 兜底页；
  - 新增 `tabs` 动作：支持 AI 随时查询当前所有打开标签页的 ID、标题、URL 与计数；
  - **内建 Linux 防退出安全兜底机制**：关闭最后一个标签页时自动预置空白页，杜绝 Linux X11 下 Chromium 进程因所有 Tab 关闭而异常退出或白屏。
- ⚡ **底层默认智能复用导航 (`browser_open`)**：
  - `browser_open` 默认采用智能复用（`newTab: false`），优先在现有空白页或工作页中通过 CDP `Page.navigate` 导航新 URL，从底层根除 AI 遗忘漏关导致的 Tab 堆积与容器内存暴涨；
  - 显式支持多标签对比：传入 `newTab: true` 可独立开启新 Tab，返回值包含 `tabId` 与 `reused` 标识。
- 📸 **截图保存路径与格式全面重构 (`browser_screenshot`)**：
  - 彻底解决固定死锁路径（`/workspace/screenshot.png`）导致多次截图互相覆盖、历史丢失的问题；
  - 赋予 AI 充分自主权：支持传入自定义 `savePath`（无论是相对当前工作区路径还是绝对路径）；
  - 缺省时间戳唯一命名：未指定路径时，自动在工作区生成带纯数字时间戳的唯一图片文件（如 `screenshot-20260907120000.png`），确保多步截图全部持久保留；
  - 修复画质压缩时强行将 `.png` 改名为 `.jpg` 引发的后续工具找不到文件的缺陷，严格按指定文件扩展名选择编码引擎；
  - 系统提示词（`systemPrompt`）全面优化，明确引导 AI 传入业务路径与适时释放资源。
- 🧪 **自动化测试与工程规范升级**：
  - 完善本地构建脚本 `build.sh` 对 GitHub Container Registry (`ghcr.io`) 镜像标签的自动映射；
  - 全链路测试闭环与自动化交付门禁固化。

---

## [v0.0.4] - 2026-09-05

### 工具集成与文档
- 集成官方 GitHub CLI (`gh`) 与 `openssh-client`；
- 支持动态桌面分辨率（默认 1080p）与动态截图质量选择（high/medium/low）；
- 统一镜像与文档默认认证码为 `admin`；
- 增加管理后台控制面板展示文档与架构细节。

---

## [v0.0.3] - 2026-09-04

### 后台管理与异步备份
- 在 Web Admin 控制台增加 DSH 主进程手动启动/停止/重启控制；
- 增加 DSH 插件/扩展识别与可视化管理面板；
- 将备份与导入服务从 Admin Web 服务解耦为异步非阻塞服务；
- 集成 `p7zip-full` 与 `pigz` 多线程压缩工具，提升备份导出速度。

---

## [v0.0.2] - 2026-09-04

### 基础环境与网络修复
- 预装最新官方 Golang 开发环境、完整中文字体与 Emoji 字体，解决中文与符号乱码；
- 修复权限模式，凭据文件严格遵循 600 权限；
- 增加 `patch-dsh-client.mjs` 客户端回环持久化补丁，彻底绕过原生 DSH 的 `isLoopback` 限制，解锁远程 IP/域名下的模型配置能力；
- 预置已确认声明配置，避免弹窗阻塞启动。

---

## [v0.0.1] - 2026-09-04

### 初始发布
- 初始容器化交付版本；
- 集成 DeepSeek Harness 核心、Xvfb、Openbox、x11vnc、noVNC 与 Chromium；
- 提供 Node.js 自研统一安全网关（统一端口 3080、Cookie/Token 认证、反暴力破解频率限制、CSWSH 防御）。
