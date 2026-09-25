# Issue #7 架构设计备忘：DSH 核心版本隔离、秒级回切与生命周期治理

- **议题**：[misaka-link/deepseek-harness-docker#7](https://github.com/misaka-link/deepseek-harness-docker/issues/7)「关于版本更新的问题」
- **作者**：Gemini（高级容器与系统架构师）
- **核验基准**：本仓库工作树（v0.1.8，commit `db57c70`），以源码真实行为与运行时实测为准
- **核心结论**：**维护者无需增加备份弹窗。问题本质并非「是否征求用户备份同意」，而是「版本缓存落点错误导致持久化失效」，以及「既有切换流程存在破坏性删除与静默失败」。推荐架构：活动核心保留在容器层以确保 Node 模块解析与镜像升级语义正常，版本存储库独立持久化，通过原子 Staging Swap 实现秒级无损热切与确定性回滚。**

---

## 1. 根因深度剖析（Root-Cause Analysis）

上报者反馈：*「控制台现在更新，新的 dsh 会直接覆盖老的，切回老的需要重新下载，如果能把老的版本隔离开来，切换直接读取之前已经下载好的，就不用重新拉取了。」*

经过对容器文件系统、编排配置及网关源码的逐行审计与实机核验，上报者的体感完全属实，但其底层根因比用户描述的「覆盖」更加严重与复杂。

### 1.1 版本缓存落点为容器不可持久化可写层
- 在 `gateway/dsh-manager.js:149` 中，版本缓存目录被硬编码为：
  `this.versionsCacheDir = '/app/.dsh-versions-cache';`，并在 `:165` 构造时尝试 `fs.mkdirSync(...)`。
- 检查镜像与编排配置：
  - `Dockerfile:365` 声明的卷仅有 4 个：`VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/workspace", "/root/.config/chromium"]`。
  - `docker-compose.yml:56-64` 与 `docker-compose.market.yml:53-61` 挂载的卷同样严格对应上述 4 个目录，**没有任何卷挂载到 `/app`**。
- **后果**：`/app/.dsh-versions-cache` 驻留在 OverlayFS 容器可写层中。任何容器生命周期变更（包括用户执行推荐的 `docker compose pull && docker compose up -d` 升级、`docker compose down && up` 重建容器，或宿主看门狗销毁重建容器），都会彻底蒸发 `/app` 下的全部缓存。用户在容器生命周期内即使缓存了旧版本，容器重建后切回旧版本必然触发 `npm install -g` 重新全量下载。

### 1.2 概念双重混淆：维护者的 A/B 困惑与现有能力重叠
维护者询问：*「是切换前弹出是否备份版本，还是怎么样实现」*。此问题源于两层关键混淆：
1. **混淆了「用户配置/会话备份」与「核心引擎二进制归档」**：
   - `gateway/backup-service.js:5,197,236` 负责的备份是通过 `tar -cf ... -C /root .dsh` 打包配置、插件、模型凭据及会话历史到 `/root/.dsh-snapshots`，它完全不包含 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 核心引擎包。
   - 上报者痛点是 538MB 的 npm 核心包被覆盖后回切需要重新联网拉取，配置备份对此毫无助益。
2. **忽视了前端切换防呆确认弹窗早已存在**：
   - `gateway/public/admin.html:2209-2318` 已经存在 `#switchConfirmModal` 确认弹窗（CHANGELOG.md:235 记载）。
   - 在弹窗中，`:3649-3651` 已实现了数据源状态展示（`⚡ 本地快照秒级还原 (< 1s)` vs `🌐 npm 镜像下载安装`），并在 `:2311-2315` 提供了明确的按钮选择：`跳过备份，确认切换` 与 `⭐ 一键备份并切换 (推荐)`。
   - 用户点击「一键备份并切换」时，`admin.html:3784-3790` 调用的是 `/api/snapshots/create` 生成用户配置快照；而核心包在 `gateway/dsh-manager.js:955-975`（阶段 2）本就会**无条件自动快照**。
   - **结论**：增加「是否备份核心」的弹窗纯属重复建设。引擎核心缓存作为基础设施底座，对用户应是透明、免感知、全自动的，向用户弹窗询问是否缓存核心二进制包违反交互直觉。

### 1.3 容器内既有切换逻辑的工程缺陷（全部附代码行号证据）
即使在未重建容器的单一生命周期内，现有缓存机制也存在严重的鲁棒性漏洞：
1. **裸 `spawnSync` 返回码被无条件吞噬，静默失败**：
   - 阶段 2 快照（`dsh-manager.js:968-969`）、阶段 3 部署（`:983-986`）、阶段 5 新版本归档（`:1077-1078`）及失败回滚（`:1130-1133`）全部使用裸 `spawnSync`，从不检查 `status` 或 `error`。
   - 即使磁盘已满（ENOSPC）导致 `cp` 失败，网关依然在 `:970` 打印 `✔ 稳定版本本地快照存档就绪`，并在 `:987` 虚假宣布 `✔ 核心文件与软链已完成秒级还原 (耗时 < 1s)`。
2. **先删后拷破坏性覆盖，中断或错误直接导致核心崩溃**：
   - 在阶段 3 缓存命中分支（`dsh-manager.js:983-985`），程序**先执行 `rm -rf /usr/local/lib/node_modules/@deepseek-ai/dsh`**，再执行 `cp -a`。
   - 一旦 `cp` 过程因断电、容器强制终止或磁盘空间不足失败，现场没有保留任何可用核心，容器直接变砖。
3. **缓存有效性判定严重失真，损坏版本成为永久毒丸**：
   - `getCachedVersions()`（`dsh-manager.js:376-379`）与阶段 3（`:981`）仅校验 `fs.existsSync(path.join(dir, 'package.json'))`。
   - 538MB 的目录拷贝若中途被 SIGKILL 中断，只要根层 `package.json` 已写入，残缺目录就会被判定为「有效快照」，并在 UI 展现为「⚡ 本地快照」。下次切换命中时部署该残缺版本，导致 DSH 进程启动崩溃。
4. **脏快照目录永久阻断回滚点刷新**：
   - 阶段 2（`dsh-manager.js:966`）判断快照存在的条件是 `!fs.existsSync(prevBackup)`。只要该目录存在（哪怕是空目录或残缺目录），程序便在 `:972` 打印 `✔ 本地已存在稳定版本...具备秒级回滚能力` 并跳过拷贝。损坏的快照目录将永久阻止生成正确快照。
5. **`.invalid-<ts>` 幽灵目录泄漏 538MB 磁盘空间**：
   - `dsh-manager.js:964` 当版本号未能通过严格 semver 检查时，将 `prevBackup` 赋值为 `.invalid-<Date.now()>`，随后 `:968-969` 会完整拷贝 538MB 核心树进去。
   - 类似目录因版本格式被 `isValidVersion`（`dsh-version.js:14`）过滤而无法在管理界面列出或清理，成为无法回收的死重。
6. **无任何 GC、容量配额与清理策略**：
   - 实测当前活动核心体积：`du -sh /usr/local/lib/node_modules/@deepseek-ai/dsh` = **538MB**（共 28,791 个文件）。
   - 全仓库没有任何对缓存目录的清理逻辑。每切一次新版本净增 ~540MB，在 overlayfs 可写层中反复累积，极易耗尽宿主根分区空间。

---

## 2. 核心架构裁决：活动核心与版本存储的解耦设计

在系统架构上，对于「活动核心（Active Core）」的承载形式，存在两个截然不同的设计流派：
- **方案 A（前期草案推崇）**：持久化指针 `active.json` + `/usr/local/bin/dsh` Shim 脚本，版本仓库直接兼作运行目录。
- **方案 B（Gemini 推荐方案）**：活动核心保留在容器 OverlayFS 标准路径，版本存储库独立持久化，切换时通过原子 Staging Swap（安全拷贝与目录重命名）执行。

### 2.1 为什么坚决否定方案 A（指针 + Shim 模式）？
方案 A 表面上具备「O(1) 零拷贝秒切」的理论诱惑力，但在本项目复杂的深度定制 Node.js/容器底座环境下，存在**致命的系统性破坏风险**：

1. **彻底打破 Node.js 模块解析拓扑与插件软链系统（裂脑灾难）**：
   - 查看构建层：`Dockerfile:289-294` 在构建时将 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*` 下的 **80 多个子包**（包括 `schemastery`, `cordis`, `dsh-agent` 等）逐一建立绝对软链到 `/usr/local/lib/node_modules/@deepseek-ai/*`。
   - 查看插件预装层：`Dockerfile:311-315` 预装插件 `dshmarket` 与 `@hytime/dsh-thinking-effort` 内部的 `node_modules/@deepseek-ai` 同样软链指向 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`。
   - 查看动态装配脚本：`scripts/install-plugin.mjs:231-259` 依赖 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 存在以补齐外部插件依赖；`scripts/patch-dsh-client.mjs:8-14, 31-35` 显式扫描 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 并就地改写代码。
   - **系统后果**：若仅把 `/usr/local/bin/dsh` 改为调用外部持久化版本的 Shim，而 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 不变，系统将陷入「裂脑（Split-Brain）」：DSH 主进程以持久化版本 X 启动，但当它动态加载 `dshmarket` 或运行期插件时，插件沿软链解析到的却是旧核心的 `schemastery` 与 `cordis`，API 不匹配立即引发运行时 TypeError 崩溃！
2. **破坏不可变基础设施准则，导致「镜像升级僵尸核心（Zombie Core）」**：
   - 容器最佳实践的核心原则是：`docker compose pull && docker compose up -d` 必须让用户开箱即用体验最新发布的官方优化、补丁及基座兼容。
   - 若活动核心由卷中的 `active.json` 控制，用户拉取新镜像后，容器启动脚本若盲从 `active.json`，新容器将忽略镜像构建期打磨好的新版本，强制加载宿主卷里残留的陈旧版本。
   - 严重者如底层 Node/glibc ABI 升级（如 CHANGELOG 记录的 Debian Trixie + Node 24 升级），持久卷中以旧版 Node 编译的 `node-pty.node` 原生 C++ 模块直接抛出 `NODE_MODULE_VERSION` mismatch 导致启动死锁。
3. **宿主 Bind-Mount 文件系统的 POSIX 权限缺陷**：
   - 用户多在 Windows (Docker Desktop NTFS/WSL2) 或 macOS 下运行 docker-compose。挂载卷文件系统往往丢失 Linux 原生执行位（`+x`）。
   - `Dockerfile:295-296` 特别强调 `spawn-helper` 必须具备 `chmod 0755` 权限。若在宿主挂载卷中直接运行 DSH，终端进程派生极易遭遇 `EACCES` 报错。

### 2.2 Gemini 架构选型：规范路径活动核心 + 卷隔离存储 + 原子 Staging 切换
本设计坚持标准容器架构设计原则：
1. **单一真实信源（Single Source of Truth）**：
   - 活动核心始终位于规范路径 `/usr/local/lib/node_modules/@deepseek-ai/dsh`，享受 OverlayFS 原生的 Linux POSIX 权限语义、绝对路径解析一致性与原生模块执行效率。
2. **真实 I/O 成本可控（真·秒级热切）**：
   - 在当前容器内实测 538MB 核心树的端到端 `cp -a` 耗时：**仅 4.636 秒**（Page Cache 命中时更快）。
   - 相比于通过国内 npm 镜像拉取耗时 25~45 秒、国际源耗时 60~120 秒及元数据竞态失败风险，4.6 秒的本地磁盘置换已充分满足用户对「秒级回切」的预期。
3. **绝对安全的原子 Staging Swap（告别破坏性覆盖）**：
   - 切换时不在现网目录直接覆盖，而是先复制/解压至同文件系统下的 Temporary Staging 目录。
   - 校验通过后，使用标准 POSIX 目录重命名（`rename`）瞬间置换。若任何阶段发生 I/O 错误或磁盘打满，现网核心毫发无伤，系统具备确定性自愈能力。

---

## 3. 详细设计与实现全景图（Concrete Implementation Sketch）

### 3.1 存储布局与 Volume 声明

#### 3.1.1 独立持久化存储库路径
在容器内设立专有版本存储目录：`/root/.dsh-versions`（非 root 模式为 `/home/dsh/.dsh-versions`）。

**绝不能将版本缓存放在 `/root/.dsh` 内的致命原因**：
- 审查 `gateway/backup-service.js:212-236`：配置快照服务打包命令为 `tar -cf <tmpPath> -C /root .dsh`。若将多份 538MB 的版本缓存放入 `.dsh`，用户每次点击「备份」将打包数 GB 垃圾，迅速击穿 `backup-service.js:9` 的 `MAX_UPLOAD_BYTES = 300MB` 上限并耗尽磁盘！
- 审查 `gateway/backup-service.js:360-379`：快照恢复逻辑在原子切换配置时，会执行 `moveChildren(DSH_DIR, rollbackRoot)` 并在成功后执行 `fs.rmSync(rollbackRoot, { recursive: true })`。若版本缓存在 `.dsh` 下，**用户恢复一次配置快照就会彻底抹杀全部历史版本缓存**！

#### 3.1.2 存储目录树规范
```text
/root/.dsh-versions/
├── .meta/
│   ├── index.json               # 版本注册表 (版本号, 体积, nodeAbi, 创建时间, 最后使用时间, 锁定标记)
│   └── lock                     # 跨进程/并发互斥锁文件
├── .staging/                    # 切换/下载临时隔离区 (进程退出或启动对账时清理)
│   └── .tmp-staging-<uuid>/
├── 0.1.7-rc.1/                  # 经校验就绪的纯净版本目录
│   ├── .ready                   # 状态完整性签名文件 (包含 sha256 校验和与构建元数据)
│   ├── package.json
│   └── node_modules/
└── 0.1.6-alpha.1/
    ├── .ready
    ├── package.json
    └── node_modules/
```

#### 3.1.3 Dockerfile 与 Compose 配置变更清单
1. **`Dockerfile:365`** 补充专用存储卷声明：
   ```dockerfile
   VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/root/.dsh-versions", "/workspace", "/root/.config/chromium"]
   ```
   并在 `Dockerfile:329` 与 `330` 的 `mkdir` 队列中同步加入 `/root/.dsh-versions` 与 `/home/dsh/.dsh-versions`，赋予 `chown -R dsh:dsh` 权限。
2. **`docker-compose.yml:62`** 与 **`docker-compose.market.yml:59`** 的 `volumes` 段同步新增持久化挂载：
   ```yaml
       # 5. DSH 多核心版本隔离持久化存储库 (保障版本回切免拉取秒级还原)
       - ./data/versions:/root/.dsh-versions
   ```

---

### 3.2 切换生命周期与健壮性改造（`gateway/dsh-manager.js`）

#### 3.2.1 基础工具函数改造
废弃无检查的裸 `spawnSync`，引入带错误阻断的原子执行器：
```javascript
function execSyncSafe(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')} (exit code ${res.status}): ${res.stderr || res.stdout}`);
  }
  return res;
}
```

#### 3.2.2 阶段 2：当前稳定版本原子归档
在切换前对当前活动版本进行存档（若存储库中尚未存在该版本）：
1. 校验当前版本有效性，拒绝 `.invalid-*` 脏命名。
2. 检查 `/root/.dsh-versions/<previousVersion>/.ready`。若已存在且合法，直接复用，杜绝空目录陷阱。
3. 若不存在，在 `/root/.dsh-versions/.staging/.archive-<uuid>` 创建临时目录，通过 `cp -a /usr/local/lib/node_modules/@deepseek-ai/dsh/. <staging>/` 拷贝。
4. 校验 `<staging>/package.json` 中的版本字段是否完全匹配 `previousVersion`，并核验 `node_modules` 存在且非空。
5. 写入 `.ready` 元数据文件（包含 `timestamp`, `nodeVersion: process.versions.node`, `arch: process.arch`）。
6. 原子重命名：`fs.renameSync(stagingPath, finalVersionPath)`。

#### 3.2.3 阶段 3：目标版本部署（双轨原子 Staging 置换）
无论是命中本地快照还是联网拉取，**严禁先对活动目录执行 `rm -rf`**！
1. **磁盘水位预检（Pre-flight Disk Check）**：
   - 调用 `fs.statfsSync('/usr/local/lib/node_modules/@deepseek-ai')`。
   - 切换安全水位设定：可用空间必须 $\ge 1.5\text{ GB}$（容纳 540MB Staging + 540MB 现网备份 + 400MB 运行余量）。
   - 若空间不足，自动触发存储库 LRU GC；若仍不足，**直接拒绝切换并友好报错，现网服务保持稳定运行**。
2. **Staging 准备**：
   - 设立容器层临时置换目录：`/usr/local/lib/node_modules/@deepseek-ai/.dsh-staging-<pid>`。
   - **分支 A（命中缓存）**：从 `/root/.dsh-versions/<version>` 执行 `cp -a` 复制到该 Staging 目录（耗时约 4 秒）。
   - **分支 B（未命中缓存）**：在 Staging 目录执行 `npm pack` + 解包或指定前缀安装，下载成功并校验完整性后，先同步向 `/root/.dsh-versions/<version>` 归档一份。
3. **阶段 4 装配执行于 Staging 目录**：
   - 针对 Staging 目录执行客户端补丁与插件依赖校验，确保补丁与新核心完全匹配。
4. **两阶段原子切换（Two-Phase Commit Directory Swap）**：
   ```javascript
   const activeDir = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
   const backupDir = '/usr/local/lib/node_modules/@deepseek-ai/.dsh-rollback-active';
   const stagingDir = `/usr/local/lib/node_modules/@deepseek-ai/.dsh-staging-${process.pid}`;

   // 1. 将现网核心移至回滚备份点 (同挂载点，毫秒级原子 rename)
   fs.renameSync(activeDir, backupDir);
   try {
     // 2. 将就绪的 staging 目录转正为活动核心
     fs.renameSync(stagingDir, activeDir);
     // 3. 刷新 bin 软链接
     execSyncSafe('ln', ['-sfn', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/bin/dsh']);
     // 4. 清理旧回滚备份
     fs.rmSync(backupDir, { recursive: true, force: true });
   } catch (swapErr) {
     // 灾难自愈：立即回滚原有目录
     if (fs.existsSync(backupDir) && !fs.existsSync(activeDir)) {
       fs.renameSync(backupDir, activeDir);
     }
     throw swapErr;
   }
   ```

#### 3.2.4 阶段 5 探活失败与自动回滚
- 若目标版本无法通过 HTTP 就绪探针，触发安全熔断。
- 回滚不再盲目执行 `rm -rf` + 联网拉取，而是直接读取 `/root/.dsh-versions/<previousVersion>`，同样以 Staging Swap 模式无损切回，恢复服务。

---

### 3.3 存储治理与 GC 保留策略

#### 3.3.1 版本分类与保留配额规则
- **默认保留策略**：保留 **3 份** 核心版本（最多不超过 5 份）：
  1. **当前运行版本（Active Version）**：绝对受保护，任何策略均不可删除。
  2. **镜像出厂基准版本（Image Baked Version）**：从 `version.json#supply.dshVersion` 读取（当前为 `0.1.7-rc.1`）。作为宿主兜底基准，标记为 `pinned: true`，永久禁止删除。
  3. **上一稳定回滚版本（Last Stable Version）**：作为熔断后备。
- **自动淘汰算法**：基于 LRU（最近最少使用），根据 `index.json` 中记录的 `lastUsedAt` 时间戳进行排序。淘汰未标记 `pinned` 且非活动状态的最旧版本。

#### 3.3.2 网关新增管理 API 规范
所有接口均纳入网关 Admin Session 鉴权防护链路下，且参数强制经由 `gateway/dsh-version.js` 的 `isValidVersion` 与 `resolveWithinDir` 严格校验，彻底杜绝目录穿越：
1. **`GET /api/dsh/versions/stats`**：
   - 返回版本库统计：已用容量、卷可用空间、保留上限及已归档版本清单。
2. **`POST /api/dsh/versions/gc`**：
   - 触发版本清理。支持 Payload `{ keepN: 3, dryRun: false }`，返回释放字节数与清理清单。
3. **`DELETE /api/dsh/versions/:version`**：
   - 删除指定版本。**后端强行拦截规则**：若 `:version` 等于当前运行版本或镜像内置版本，直接返回 HTTP 403 拒绝执行。

---

### 3.4 前端界面升级（`gateway/public/admin.html`）

1. **版本切换确认弹窗（`#switchConfirmModal`，`:2209-2318`）语义重塑**：
   - 修改 `:2229-2231` 部署获取方式徽标：
     - 若命中存储库（`.ready` 校验通过）：
       `<span class="badge-chip chip-blue">⚡ 本地快照秒级还原（已就绪 538MB · 预计 4 秒）</span>`
     - 若未命中存储库：
       `<span class="badge-chip chip-gray">🌐 npm 镜像下载安装（需拉取约 540MB · 预计 30 秒）</span>`
   - 弹窗底部补充存储空间提示：`当前磁盘剩余: XX GB · 本地已安全归档 N 个版本`。
   - 保留现有的「⭐ 一键备份并切换 (推荐)」按钮，并在文案中明确标注「备份指生成当前配置与会话快照；核心引擎版本将由底层全自动归档」，消除用户理解壁垒。
2. **版本与更新控制中心（`#versionHubModal`，`:2322+`）新增版本存储看板**：
   - 在右侧适配列表旁，增加「本地已归档版本管理」卡片。
   - 列表展示版本号、占用体积、归档时间、状态标识（`活动中` / `镜像内置` / `已归档`），提供单项「删除」与「一键清理旧版本 (GC)」交互。

---

## 4. 对前序草案（Prior Draft）的对抗式系统架构批判

前序草案提出的核心构想是：*(C)+ 方案：将活跃核心也持久化（active.json 指针 + /usr/local/bin/dsh Shim），使切换退化为 O(1) 指针改写，避免 540MB 复制。*

作为资深架构师，我们必须以对抗性思维指出：**该草案方向看似精妙，实则存在多处对容器底座与 Node 运行时特性的严重误判，如果按其落地将引入极其严重的线上故障。**

### 4.1 批判 1：致命的裂脑矛盾与软链失效（Fatal Architectural Flaw）
- **草案主张**：`/usr/local/bin/dsh` 替换为一个 Shim 脚本，启动时读取 `active.json` 并调用对应目录的 `lib/bin.js`。
- **事实打脸**：DSH 绝非一个自包含的单二进制程序。前文已详尽论证，镜像构建期 `Dockerfile:288-296` 在 `/usr/local/lib/node_modules/@deepseek-ai/` 建立了多达 80 余个绝对软链指向主包下的同名子包。外部插件（如 `dshmarket`）同样死死挂钩该路径。
- **后果**：草案如果仅切了 Shim 指针，`/usr/local/lib/node_modules/@deepseek-ai/dsh` 根本没变。主程序在 A 目录跑，内部动态加载的类库全在 B 目录找，引发灾难性的跨版本类库冲突，插件中心全面报废。

### 4.2 批判 2：破坏容器不可变基础设施与更新语义（The Zombie Core Bug）
- **草案主张**：让活动核心成为持久化对象，跨容器生命周期驻留在 Volume 内。
- **事实打脸**：在 Docker 最佳实践中，镜像代表着经 CI/CD 充分验证与集成的 Golden Image。
  若将活动指针持久化，当维护者发布 `deepseek-harness-docker:v0.1.9`，内置修复了关键漏洞的新核心及对应匹配的 Node 依赖；用户执行 `docker compose pull && docker compose up -d` 后，容器一开机，Shim 盲目读取持久化挂载卷里的 `active.json`，**直接将用户强制锁定在宿主卷里残留的老版本上**！
  新镜像里的代码被完全架空，彻底违背用户拉取新镜像的意图。

### 4.3 批判 3：版本库「不可变性」与阶段 4 就地打补丁自相矛盾（Mutable Cache Paradox）
- **草案主张**：版本仓库中的 `<version>/` 为「不可变核心树」。
- **事实打脸**：检查 `scripts/patch-dsh-client.mjs:106, 125, 162, 232, 256, 274, 293`，该脚本使用 `fs.writeFileSync` **就地改写**核心文件的源码。
  如果运行目录直接指向仓库目录，每次启动或切换阶段 4 都会对仓库文件执行改写。版本库根本不是不可变的！反复切入切出会导致补丁反复覆盖污染。
  反观 Gemini 推荐的 Staging Swap 模式，存储库归档的是纯净代码，运行时在容器层执行打补丁，两层职责分明。

### 4.4 批判 4：忽视了 `backup-service.js` 的毁灭性联动冲击
- 前序草案建议直接使用常规持久化卷，但未深入分析 `backup-service.js` 的源码。如前所述，若不严格隔离卷，现有备份服务的 `tar -C /root .dsh` 与恢复服务的全量清理逻辑，要么把几 GB 的版本包打包进配置快照导致备份服务超时崩溃，要么在用户恢复配置时将整个版本存储库作为垃圾清理一空！

---

## 5. 风险评估与极端边界应对矩阵（Risks & Edge Cases）

| 风险/边界场景 | 影响机制 | 架构级防范与兜底对策 |
|---|---|---|
| **1. 镜像升级与本地切换版本冲突** | 用户此前在控制台切到了历史版本，随后执行 `docker compose pull && up -d` 更新了镜像 | **镜像出厂版本优先级裁决**：网关启动对账时比对镜像内 `/app/version.json` 的 `supply.dshVersion`。若检测到底座镜像更新，**容器默认优先拉起新镜像内置的官方适配核心**；历史切换版本保留在存储库中，供用户在界面随时秒切。杜绝旧版本绑架新镜像。 |
| **2. 补丁锚点漂移 (`patch-dsh-client.mjs`)** | 切换到未适配的新版或极旧版本，补丁脚本找不到匹配的字符串锚点 | `scripts/patch-dsh-client.mjs:21` 已内置必需补丁检查（`REQUIRED_PATCHES`）。网关将补丁执行结果纳入 Staging 阶段验收；若补丁失败，阻断激活并回滚，在管理界面高亮提示「该版本与当前容器补丁层不兼容，建议更新 Docker 镜像」。 |
| **3. Node ABI 与原生模块失效 (`node-pty`)** | 镜像跨大版本升级（如 Node 22 $\rightarrow$ Node 24），历史缓存的原生模块无法加载 | `.ready` 文件记录编译时的 `nodeAbi` 与 `arch`。启动或切换预检若发现 `cachedAbi !== process.versions.modules`，该缓存自动失效并标记为「需重新编译/下载」，避免 SIGSEGV 崩溃。 |
| **4. 会话数据单向不可逆迁移 (V3/V4)** | DSH 0.1.5 起会话升级为 V3，0.1.7 起升级为 V4（`version.json:184-204`），降级后旧引擎无法读取新格式 | **此属 DSH 上游应用层不可逆迁移**。底层引擎切换无法篡改会话内容。设计方案在前端降级警告卡（`admin.html:2256-2266`）中持续强调该风险，并强制要求在降级前利用 `backup-service.js` 导出配置与会话快照。 |
| **5. 磁盘空间极度不足 (ENOSPC)** | 宿主磁盘满，538MB 写入中途失败 | 严格实施**写前 `statfs` 空间配额探针**与 **LRU 自动 GC**。必须确保磁盘拥有 $\ge 1.5\text{ GB}$ 空间才准许启动 Staging 流程，且绝不提前破坏正在运行的活体核心。 |
| **6. 切换中途容器断电或强杀 (Crash In-flight)** | 用户在 `rename` 或 `cp` 过程中执行了 `docker stop` | Staging 临时目录均以 `.tmp-staging-<pid>` 隔离。容器启动初始化时由 Entrypoint 执行扫尾清理；现网目录利用 POSIX 同一文件系统目录原子置换，保证 live 目录要么处于 100% 旧版本，要么处于 100% 新版本，绝不存在半死半生状态。 |
| **7. 跨架构数据卷迁移 (Multi-Arch)** | 用户将 x86 宿主上的 `./data/versions` 拷贝到 ARM64 (Apple Silicon) 宿主运行 | 存储库的元数据明确区分 `arch: linux-x64` vs `arch: linux-arm64`。架构不一致的缓存目录直接隔离，防止跨架构执行原生二进制报 `Exec format error`。 |

---

## 6. 对维护者 A/B 问题的定性回答（Maintainer's Verdict）

**结论：坚决不要做「切换前弹出是否备份版本」的弹窗，而应通过「存储卷隔离持久化 + 核心原子 Staging 置换」的系统方案来解决。**

维护者的纠结根源在于将「用户数据与会话备份（已在 `admin.html:2209-2318` 弹窗实现）」与「核心引擎二进制版本隔离（Issue #7 诉求）」混为一谈。核心引擎的缓存与版本隔离属于纯粹的基础设施支撑能力，应当在底层由网关全自动、零感知、安全幂等地维护（空间自检、Staging 原子置换、LRU 清理），任何时候都不该弹窗强迫用户做选择题；当前「切回老版依然重新下载」的唯一根因是缓存被写在了未挂载持久卷的 `/app/.dsh-versions-cache` 容器层中，导致数据随容器更新而蒸发。只要将版本库迁入独立持久卷，并消除先删后拷的工程缺陷，即可完美解决问题。

---

## 7. 架构自审：本方案明确不解决的问题（Architectural Boundaries）

作为严谨的系统架构设计，我们必须清晰划定设计边界，明确本备忘**不负责**解决的外部问题：
1. **不解决 DSH 上游核心会话格式的单向不可逆升级问题**：
   - 官方在 0.1.5 引入 V3 会话架构，在 0.1.7 引入 V4 会话架构。如果用户从 0.1.7 降级回 0.1.2，旧版 DSH 无法加载新版会话属于上游应用逻辑限制，本方案不作篡改，必须依赖数据快照备份。
2. **不解决上游破坏性代码重构导致的补丁完全失效**：
   - 若 DeepSeek 官方发布了底层架构颠覆性重构的版本（如完全移除 `isLoopbackHostname` 锚点或重写 RPC 协议），本容器内的 `patch-dsh-client.mjs` 必然失效。此时必须遵循 `admin.html:2239` 的顶级安全预警，拉取官方团队针对性适配后的新 Docker 镜像，任何容器内热切换方案均无法替代镜像重构。
3. **不解决极端弱性能磁盘的固有 I/O 延迟**：
   - 在挂载于极端慢速的 NFS/Samba 机械存储上的环境，4.6 秒的 538MB 本地置换可能会衰退至数十秒，这属于物理 I/O 瓶颈，系统仅能通过空间预检避免超时挂死。

---

## 8. 实施路径规划（Action Plan）

- **Phase 1（配置与持久化就绪）**：
  在 `Dockerfile:365` 及 `docker-compose.yml` 中新增 `/root/.dsh-versions` 卷定义；在 `gateway/dsh-manager.js` 中将缓存目录迁移至持久卷，彻底让版本跨容器重启与升级留存。
- **Phase 2（健壮性重构与安全置换）**：
  引入带错误拦截的执行器；废弃 `rm -rf` 破坏性流程，实现 Staging 隔离复制与 POSIX 原子 `rename`；引入 `.ready` 校验签名文件，重构 `getCachedVersions()` 判据。
- **Phase 3（治理与管控）**：
  网关增加容量预检、API 统计与 LRU 自动清理（保留当前 + 出厂基准 + 1 个回退版）；前端弹窗优化获取方式展示与磁盘余量呈现。