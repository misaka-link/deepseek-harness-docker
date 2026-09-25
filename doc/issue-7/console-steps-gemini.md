# DSH 控制台架构演进方案：引擎回滚点治理（Gemini 方案）

> **作者**：Gemini（资深容器 / Node.js 架构师）  
> **协作审阅**：Lead 架构师（参考 `console-plan.md`）  
> **目标文件**：`/workspace/deepseek-harness-docker/doc/issue-7/console-plan-gemini.md`  
> **状态**：方案规划阶段（本轮只出方案，不包含实现代码）

---

## 0. 架构背景与现状审计（基于代码事实）

在 Issue #7 修复落地后，DSH 核心版本切换的底层机制如下：
1. **活动核心与切换原语**：活动核心位于容器层 `LIVE_CORE_PARENT/dsh`（即 `/usr/local/lib/node_modules/@deepseek-ai/dsh`，见 `gateway/dsh-manager.js:152-153`）。在执行 `_atomicSwapCore` 时，系统将旧核心重命名暂存至 `.dsh-rollback-<pid>-<ts>`（`gateway/dsh-manager.js:1547`）。
2. **探活与清理现状**：核心切换完成并探活成功后，系统在 `gateway/dsh-manager.js:1324-1328` 显式调用 `this._disposeRollbackDir(rollbackDir)` 将其递归强删。若探活失败，则在 `gateway/dsh-manager.js:1399-1405` 通过 `_restoreFromRollbackDir()` 从该回滚点执行秒级本地还原。
3. **版本归档现状**：持久化版本库落在 `$DSH_SNAPSHOTS_DIR/versions`（`gateway/dsh-manager.js:148`），受切换前弹窗的“归档当前引擎”复选框控制（`gateway/public/admin.html:2299`），并通过 `gateway/index.js:569-585` 的 `/api/dsh/versions/stats|gc|:version` 接口提供运维能力。
4. **控制台现状**：Web Admin 面板的「快照与备份」Tab（`gateway/public/admin.html:1958-1997`）目前仅面向 `/root/.dsh` 的 `*.tar.gz` 配置文件快照（`gateway/backup-service.js:593-613`），完全缺乏对引擎底层回滚点的感知与管控手段。

针对用户提出的三大核心诉求：
1. 回滚点清理改为**手动**（探活通过后不自动删除）；
2. 默认**最多保存一份**回滚点；
3. 在管理面板「备份」Tab 中**可见、可管理、可手动删除**该回滚点；

以下从容器存储原理、Node.js 运行时一致性、接口设计与前端交互四个维度展开全景架构规划。

---

## A. 回滚点物理落点决策：容器层 vs 持久化卷

### 1. 三维度权衡矩阵

| 评估维度 | 方案一：迁移至持久化卷 (`$DSH_SNAPSHOTS_DIR/versions/.rollback/`) | 方案二（Gemini 推荐）：保留在容器层 (`LIVE_CORE_PARENT/.dsh-rollback`) |
| :--- | :--- | :--- |
| **(1) 熔断回滚即时性** | ❌ **严重降级**：宿主机根文件系统 `/` 与持久卷（挂载点 `/root/.dsh-snapshots`）属于**不同文件系统设备**（设备号分别为 113 与 46，见实测 `stat -c '%d'`）。跨设备置换无法使用内核 `rename`，必须退化为 `cp -a` + `rm -rf`（见 `gateway/dsh-manager.js:198-203`）。拷贝 477MB（20,000+ 小文件）耗时 3~15 秒，不仅拉长服务停机不可用窗口，且在 I/O 抖动时可能导致熔断超时。 | ✅ **极致即时（<50ms）**：与活动核心同处容器层设备（`LIVE_CORE_PARENT`），直接享受同文件系统毫秒级 `renameSync` 原子交换能力。切换期停服时间几乎可以忽略，熔断还原瞬间完成（`gateway/dsh-manager.js:1403`）。 |
| **(2) 控制台可见与可删** | ✅ **支持**：网关运行于容器内部，可直接读取并删除挂载卷路径。 | ✅ **完全支持**：网关在容器内同样拥有对 `/usr/local/lib/node_modules/@deepseek-ai` 的完整读写权限（核心安装即由此用户执行）。通过专用 API 呈现元数据与触发物理删除毫无障碍。 |
| **(3) 容器重建 / 镜像更新一致性** | ❌ **严重风险（Node ABI 污染）**：当用户执行 `docker compose pull && docker compose up -d` 升级基础镜像时，持久卷中的旧二进制原生模块（如 `node-pty.node`，见 `gateway/dsh-manager.js:1241`）被保留。若新镜像升级了 Node.js 大版本或系统 glibc，该回滚点因 `process.versions.modules` 错位而直接失效。若在此状态下执行还原，将导致核心进程遭遇 `SIGSEGV` 或 `Module version mismatch` 无法启动的灾难性故障。 | ✅ **天然世代隔离（Clean Slate）**：容器重建或镜像更新后，容器可写层被干净重置，旧版本的脏二进制备件自然消亡，新容器直接以出厂经过验证的核心启动。回滚点作为“当前容器会话内的应急刹车片”，随容器生命周期绑定是业界标准的云原生最佳实践。若用户需要跨容器世代永久保存，已有成熟的持久化版本归档库（`$DSH_SNAPSHOTS_DIR/versions`）承接。 |
| **(4) 空间复用与存储开销** | ❌ **双重浪费**：跨设备无法使用 Linux 硬链接（`EXDEV`）。若用户在切换时勾选了“归档当前引擎”，持久卷中将同时存在 `versions/<version>` 和 `.rollback/<version>`，单次切换白白消耗近 1GB 宿主机磁盘。 | ✅ **零多余开销**：回滚点只在容器层作为切换置换的就地沉淀物存在，不侵占外部快照持久卷的宝贵配额。 |

### 2. 结论与取舍
- **结论**：**回滚点必须且只能保留在容器层原位置（`LIVE_CORE_PARENT/.dsh-rollback`）**。
- **明确反对的做法**：
  - **坚决反对将回滚点迁至持久化卷（如 `$DSH_SNAPSHOTS_DIR/rollback/`）**！
  - *反对理由*：跨设备 `cp -a` 严重破坏熔断回滚的毫秒级 SLA，且将跨镜像更新的不兼容 Node ABI 引入持久化存储，属于典型的“为了持久化而持久化”的过度设计，违背了容器不可变基础设施原则。跨容器保留是“版本库（Versions Store）”的职责，绝非“就地回滚点（Rollback Point）”的语义。

---

## B. 保留策略：默认最多 1 份与“手动清理”的协同规则

### 1. 语义冲突与解耦
用户需求“默认最多 1 份”与“手动清理”存在潜在的设计张力：
- 若严格要求“只能手动清理，系统永不自动删”，则当已有 1 份回滚点且用户再次切换时，系统若要遵守“最多 1 份”，就必须强行阻断切换，强制用户去管理面板删除；
- 若系统在新切换时无感知删除旧回滚点，用户可能会质疑“为什么说好手动清理，系统又自动删除了”。

### 2. 规则裁定（“滑动单槽位”策略）
Gemini 给出最合理且不违背“手动”语义的规则定义：
1. **就绪状态下的静默保留（手动语义）**：
   - 切换完成并通过健康探活后，系统**绝对不再执行自动销毁**。回滚点常态化驻留于容器层，作为随时可用的就地备件，生命周期完全交由用户支配，由用户在控制台手动点击删除以释放空间。
2. **新切换触发时的自动轮替（配额语义）**：
   - 当用户发起下一次核心版本切换时，系统在阶段 1 预检阶段检测回滚点配额。
   - 若系统已存在前序回滚点，在**新版本原子置换成功且健康探活通过**后，系统将前序旧回滚点安全移出，并将本次换下的核心作为最新且唯一的备件保留（FIFO 自动轮转更新）。
   - **绝不在新版本未就绪前提前删除旧备件**：若本次新版本切换失败触发熔断，还原的依然是前序有效核心，确保安全底线。
3. **环境配置参数**：
   - 新增环境变量 `DSH_ROLLBACK_KEEP`，默认值 `1`（合法范围 `0~1`）。
   - 当设置为 `0` 时，系统退化为 Issue #7 的即时清理模式（探活通过即物理清空），供极端小磁盘环境选用。

---

## C. 后端接口设计（RESTful API 规范）

全部接口统一挂载于网关管理后台路由（`gateway/index.js`），复用既有鉴权体系（`gateway/auth.js`）。

### 1. 接口清单

#### (1) `GET /api/dsh/rollback`：获取回滚点状态与元数据
- **权限**：需要管理认证（`ADMIN_PATH` / Session Cookie / Token）。
- **处理逻辑**：
  - 检查 `LIVE_CORE_PARENT/.dsh-rollback` 是否存在；
  - 读取回滚点内的 `package.json` 与 `.ready` 元数据；
  - 校验当前容器 Node ABI 是否匹配（`process.versions.modules`）。
- **成功响应 (HTTP 200)**：
  ```json
  {
    "ok": true,
    "exists": true,
    "rollback": {
      "version": "0.1.7-rc.1",
      "sizeBytes": 500174848,
      "sizeFormatted": "477.0 MB",
      "createdAt": "2025-02-23T10:15:30.000Z",
      "nodeAbi": "115",
      "abiMatches": true,
      "path": "/usr/local/lib/node_modules/@deepseek-ai/.dsh-rollback",
      "canRestore": true
    }
  }
  ```
- **空态响应 (HTTP 200)**：
  ```json
  {
    "ok": true,
    "exists": false,
    "rollback": null
  }
  ```

#### (2) `DELETE /api/dsh/rollback`：手动物理清理回滚点
- **权限**：需要管理认证。
- **并发互斥**：若 `dshManager.installing === true`，直接阻断并返回 `HTTP 409 Conflict`：
  ```json
  { "ok": false, "error": "版本切换正在进行中，禁止删除回滚点" }
  ```
- **路径安全防御**（严格复用 `gateway/dsh-version.js`）：
  - 必须使用 `resolveWithinDir(LIVE_CORE_PARENT, '.dsh-rollback')` 进行绝对路径越界校验（`gateway/dsh-version.js:25-37`），杜绝任何利用文件名穿越删除系统文件的漏洞。
- **成功响应 (HTTP 200)**：
  ```json
  {
    "ok": true,
    "message": "引擎回滚点已彻底清理",
    "freedBytes": 500174848,
    "freedFormatted": "477.0 MB"
  }
  ```
- **异常响应**：回滚点不存在时返回 `HTTP 404` `{ "ok": false, "error": "当前不存在引擎回滚点" }`。

#### (3) `POST /api/dsh/rollback/restore`（可选/扩展）：就地还原回滚点
- **权限**：需要管理认证。
- **说明**：提供在运行期直接倒退至上一版本核心的快捷通道，免去重新下载流程。

---

## D. 前端控制台设计（Web Admin 呈现）

### 1. 位置与布局方案
在 `gateway/public/admin.html` 的「快照与备份」Tab（`#tab-snapshots`，行 1958）中，**坚决反对将回滚点混入现有 `snapshotsTableBody` 表格中**！

- **反对理由**：
  1. **语义混淆**：现有表格管理的是 `/root/.dsh` 的**用户数据与配置**（`*.tar.gz`，17KB~10MB），支持跨环境导出、导入、换机迁移；而回滚点是**系统运行时引擎备件**（477MB，纯代码与二进制），绝不能作为配置快照供用户下载导入；
  2. **操作逻辑冲突**：用户数据快照具备“还原、下载、删除”三联动作，且支持批量生成；回滚点仅单份存在，操作以“查看状态、空间释放、就地还原”为主。

- **Gemini 推荐方案：双卡片分区架构**：
  在 `#tab-snapshots` 内分为上下两张独立的 Card：
  1. **上方卡片**：`🛠️ 核心引擎就地回滚点 (System Engine Rollback Point)` —— 专管 477MB 的容器层引擎备件；
  2. **下方卡片**：`📦 DSH 用户数据与配置快照 (User Configurations & Sessions)` —— 保持现有的 `*.tar.gz` 列表结构（`gateway/public/admin.html:1959-1997`）。

### 2. 回滚点卡片视觉原型与组件规范
- **存在回滚点时的卡片形态**：
  ```
  +----------------------------------------------------------------------------------------------------+
  | 🛠️ 核心引擎就地回滚点 (系统备件)                                      [ 单份槽位配额: 1/1 ]        |
  | 切换核心版本时换下的原引擎完整副本，保留于容器可写层，用于应急故障时的秒级就地倒退。                 |
  +----------------------------------------------------------------------------------------------------+
  | [徽标: 稳定备件]  版本: v0.1.7-rc.1  |  占用空间: 477.0 MB (容器层)  |  创建时间: 2025-02-23 10:15   |
  | 运行环境: ✔ Node ABI 匹配 (兼容当前环境)                                                            |
  |                                                                                                    |
  |                                                [ ⚡ 还原此版本 ]   [ 🗑️ 清理回滚点 (释放 477MB) ]   |
  +----------------------------------------------------------------------------------------------------+
  ```
- **空态时的卡片形态**：
  - 灰色虚线边框轻量 Card：`ℹ️ 当前未保留引擎回滚点（下次切换核心版本成功后将自动在此暂存前序版本备件）。`

### 3. 删除操作二次确认规范
点击「清理回滚点」时，调用全局统一的 `askConfirm` 对话框，文案必须清晰传递风险与收益：
- **标题**：`确认清理核心引擎回滚点？`
- **内容**：
  `即将删除版本 v0.1.7-rc.1 的就地备件，可释放容器层磁盘空间约 477.0 MB。`
- **警示**：
  `⚠️ 注意：清理后若当前运行的核心版本遇到未知异常，将失去秒级就地撤销保障；后续切回该版本将依赖版本归档库或重新联网下载。`
- **按钮**：`取消` / `确认删除 (释放 477MB)`（Danger 样式）。

---

## E. 与版本切换流程的深度交互

### 1. 切换前弹窗交互优化（`#switchConfirmModal`）
在 `gateway/public/admin.html:2294-2327` 的切换确认弹窗中：
- 前端在打开弹窗时异步拉取 `/api/dsh/rollback`。
- **若当前已存在回滚点**，在备份选项区域显式增加一行温和的预期提示：
  `💡 提示：当前已保留一份前序回滚点 (v0.1.7-rc.1, 477MB)；本次切换成功后将自动轮换为当前版本备件，单份配额不额外累加磁盘空间。`
- **澄清安全说明**：将原第 2324 行文案微调为：
  `切换期间系统会自动执行置换保护：若新版本启动或探活失败，将触发安全熔断秒级回退；探活成功后该备件将持久保留于【快照与备份】面板，供您随时手动管理。`

### 2. 切换过程中的状态呈现
1. **API 锁定**：一旦进入切换状态（`this.installing = true`），前端快照面板的「清理回滚点」按钮直接置为 `disabled`，后端 API 返回 409，严禁在置换与探活期删改底座。
2. **日志与进度推送（SSE）**：
   - 探活成功分支（修改 `gateway/dsh-manager.js:1324-1328`）：
     不再执行 `this._disposeRollbackDir()`，改为输出友好日志：
     ```javascript
     log(`✔ [阶段 5/5] 端口健康就绪探活通过！`);
     log(`🛡️ 前序核心已转为就地回滚点保留 (v${previousVersion}, ~477MB)；`);
     log(`💡 如需释放磁盘空间，可随时前往管理后台【快照与备份】面板手动清理。`);
     ```
3. **切换后状态联动**：
   - 切换完成事件 `done` 触发后，前端不仅刷新版本状态，同时触发 `loadRollbackStatus()` 刷新快照面板中的回滚卡片。

---

## F. 边界防御、风险治理与自愈联动

### 1. 并发竞态安全防护
- **切换时防删**：`DELETE /api/dsh/rollback` 严格以 `dshManager.installing` 为互斥前置条件。若置换正在进行，删除请求被 409 驳回，防止置换到一半备份目录被并发删除导致熔断无退路。
- **删除时防切**：执行删除文件期间建立短期文件操作锁，阻止版本切换任务插队。

### 2. 磁盘水位预检与 GC 联动
- 回滚点长期保留约 477MB 容器层空间。
- **磁盘水位保障**：在 `gateway/dsh-manager.js:1257` 与 `:1596-1610` 的 `_assertDiskSpace` 中，预检会严格校验 `LIVE_CORE_PARENT` 的空闲空间是否满足 `MIN_FREE_BYTES`（默认 1.5GB）。
- **智能诊断提示**：当因磁盘不足导致预检失败时，若后端检测到存在回滚点，错误提示中明确追加指引：
  `"磁盘空间不足...（检测到容器层存有 477MB 引擎回滚点，可先至【快照与备份】面板清理释放空间）"`。

### 3. 重大隐患纠正：启动与后台 GC 的“误杀”风险（Critical！）
在现有代码中存在两处隐蔽的定时清理逻辑，必须同步修正，否则用户的“手动保留”会被后台无情抹杀：
1. **`scripts/entrypoint.sh:105`**：
   ```bash
   find "${CORE_PARENT}" -maxdepth 1 -name ".dsh-rollback-*" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
   ```
   *问题*：容器每次重启时，超过 60 分钟的回滚点会被 shell 脚本静默强删！
2. **`gateway/dsh-manager.js:1684-1691`**：
   ```javascript
   cleanupStagingOrphans(maxAgeMs = 3600 * 1000) { ... if (!isStoreStaging && !/^\.dsh-(staging|rollback)-/.test(name)) continue; ... }
   ```
   *问题*：每次版本库执行 GC 或系统空闲清理时，超过 1 小时的 `.dsh-rollback-*` 同样被无差别清理！

- **Gemini 修复方案**：
  - 将正式保留的回滚点固定命名为 `.dsh-rollback-preserved`，并在该目录内写入元数据标记；
  - 临时切换过程中的目录依然叫 `.dsh-rollback-tmp-<pid>-<ts>`；
  - 修改 `entrypoint.sh:105` 与 `cleanupStagingOrphans`，**严格排除 `.dsh-rollback-preserved`**，仅清理过期的 `-tmp-` 孤儿目录，坚决捍卫用户手动保留的语义！

### 4. 容器崩溃中断自愈联动
- `scripts/entrypoint.sh:95-100` 包含核心自愈机制：若容器异常重启且 `CORE_DIR` 丢失，entrypoint 会从最新的 rollback 目录就地自愈恢复核心。
- 固定命名为 `.dsh-rollback-preserved` 后，entrypoint 的自愈判断更加稳健可靠，构成了真正的无头自愈闭环。

---

## G. 架构支撑代码证据（Code Citations）

本方案的全部技术判断与改造点均直接锚定仓库实际代码：

1. `gateway/dsh-manager.js:1547` —— 当前切换期间动态生成回滚点路径：`const backupDir = path.join(LIVE_CORE_PARENT, `.dsh-rollback-${process.pid}-${Date.now()}`);`。
2. `gateway/dsh-manager.js:1582-1587` —— 探活通过后的自动销毁逻辑：`_disposeRollbackDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }`，需在此解耦。
3. `gateway/dsh-manager.js:1324-1328` —— 探活成功分支显式调用 `this._disposeRollbackDir`，需改为持久化保留并转存元数据。
4. `gateway/dsh-manager.js:1399-1405` —— 熔断回滚首选本地回滚点：`this._restoreFromRollbackDir(rollbackDir)`，证明容器层毫秒级置换对系统弹性的决定性作用。
5. `gateway/dsh-manager.js:1684-1691` —— `cleanupStagingOrphans` 盲目清理 `>3600s` 的回滚目录，证明必须做命名区隔防误删。
6. `scripts/entrypoint.sh:105` —— 启动脚本中 `find ... -name ".dsh-rollback-*" -mmin +60 -exec rm -rf`，证明必须同步修改 entrypoint 避免重启吞噬备份。
7. `scripts/entrypoint.sh:95-100` —— 核心缺失自愈逻辑 `mv "${_rb}" "${CORE_DIR}"`，证明容器层回滚点与 entrypoint 自愈架构天然契合。
8. `gateway/dsh-version.js:25-37` —— `resolveWithinDir(baseDir, name)` 核心安全防御函数，新 DELETE API 防路径穿越必须强依赖该函数。
9. `gateway/backup-service.js:593-613` —— `listBackups()` 只检索 `SNAPSHOTS_DIR` 下的 `*.tar.gz`，证明快照服务定位为用户配置，不应承载底层引擎备件。
10. `gateway/public/admin.html:1958-1997` —— `#tab-snapshots` 现有 DOM 结构，证明需新增独立的引擎回滚看板 Card。
11. `gateway/public/admin.html:2294-2326` —— 切换前弹窗备份选项与安全兜底文案，需根据单份保留策略做文案预期对齐。
12. `gateway/dsh-manager.js:239-246` —— `isReadyVersionDir` 严格校验 `nodeAbi` 证明跨镜像二进制存在天然不兼容，否定了持久卷保存方案。

---

## H. 全功能可测性验收清单（Acceptance Checklist）

| 序号 | 测试场景 | 操作步骤 | 预期判定标准（全部客观可观察） |
| :---: | :--- | :--- | :--- |
| **T1** | 探活后自动保留 | 在管理面板将 DSH 从 v0.1.7-rc.1 切换至 v0.1.6-alpha.2 并探活成功 | 检查容器层 `ls -d /usr/local/lib/node_modules/@deepseek-ai/.dsh-rollback-preserved` 目录完好存在；日志输出保留提示；探活后**未被删除**。 |
| **T2** | 面板元数据呈现 | 打开管理后台「快照与备份」Tab | 顶部专属卡片正确显示所属版本号（v0.1.7-rc.1）、表观体积（~477MB）、创建时间及“Node ABI 匹配”徽标。 |
| **T3** | 手动删除与空间释放 | 点击回滚点卡片上的「清理回滚点」并在二次弹窗中确认 | 弹出确认提示；请求 `DELETE /api/dsh/rollback` 成功返回 200；目录被彻底移除；页面回滚卡片切换为空态；`df` 可观察到容器层空间释放 ~477MB。 |
| **T4** | 并发切换锁保护 | 发起版本切换，在 SSE 日志流推送期间，用 curl 并发请求 `DELETE /api/dsh/rollback` | 接口立即返回 HTTP 409 Conflict，提示“版本切换正在进行中，已拒绝并发删除”；切换主流程不受干扰。 |
| **T5** | 默认最多一份单槽位轮换 | 在已有回滚点的情况下，再次执行核心版本切换至 v0.1.5-rc.1 | 切换成功后，旧回滚点被平滑置换为刚换下的版本；容器内仅保留最新的一份 `.dsh-rollback-preserved`，目录数严格保持为 1。 |
| **T6** | 越界路径穿越防御 | 构造恶意删除请求 `DELETE /api/dsh/rollback` 携带恶意 payload 或尝试传参越界 | 后端调用 `resolveWithinDir` 拦截，阻断任何试图逃逸出 `LIVE_CORE_PARENT` 的非法删除操作。 |
| **T7** | 启动与 GC 防误杀验证 | 保留回滚点，修改系统时间或触发生效 `cleanupStagingOrphans` 及重启容器 `docker restart` | 回滚点目录因受保护命名机制未被 `entrypoint.sh` 与 `cleanupStagingOrphans` 清理，面板依然可见可用。 |
| **T8** | 故障熔断回退保障 | 切换至一个伪造启动失败的测试版本 | 触发健康探活失败后，系统直接从回滚点秒级恢复稳定核心，现网服务保持完好，回滚备件发挥兜底职责。 |

---

## 5 行最终架构推荐摘要

1. **落点与物理安全**：回滚点坚守容器层单槽位（`LIVE_CORE_PARENT/.dsh-rollback-preserved`），保障毫秒级置换/熔断且杜绝跨镜像 Node ABI 污染。
2. **保留策略与轮转**：默认保留 1 份且探活后不自动删除；新切换触发时自动轮换旧备件，提供 `DSH_ROLLBACK_KEEP` 环境配置。
3. **接口与防御强化**：提供 `/api/dsh/rollback`（GET/DELETE），集成 `resolveWithinDir` 防穿越与 `installing` 并发互斥锁。
4. **前端专属分区卡片**：在备份 Tab 顶部建立独立专属看板，彻底隔离“477MB 系统引擎备件”与“17KB 用户配置快照”，配套二次确认弹窗。
5. **生态与自愈治理**：同步改造 `cleanupStagingOrphans` 与 `entrypoint.sh` 排除正式回滚点，彻底根治 60 分钟定时误杀隐患。
