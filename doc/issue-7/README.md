# Issue #7 结论与实施建议（Lead 汇总）

> 议题：[misaka-link/deepseek-harness-docker#7](https://github.com/misaka-link/deepseek-harness-docker/issues/7)「关于版本更新的问题」
> 讨论参与方：Lead（deepseek-v4.1-flash）· Gemini（newapi/gemini-3.8-flash，独立设计）· verifier（独立核验 + 对抗式复核）
> 产出：[design-gemini.md](design-gemini.md)（Gemini 设计备忘）· [verification.md](verification.md)（核验与对抗式复核）· 本文件（汇总裁决）

---

## 0. 一句话结论

**不要做「切换前弹出是否备份版本」的弹窗——它早就存在了。**
Issue #7 的病根不是「没问用户要不要备份」，而是**版本缓存被写在容器不可持久化的 `/app` 里**，容器一重建（`docker compose pull && up -d`）缓存就蒸发，回切只能重新下载。
正确解法：**版本存储库迁到独立持久化卷 + 活动核心原子 Staging 置换 + 完整性校验/GC 治理**。

---

## 1. 讨论过程

| 角色 | 路由 | 交付 |
|---|---|---|
| Gemini（独立架构师） | `newapi/gemini-3.8-flash` | `design-gemini.md`（306 行，根因/方案裁决/实施全景/风险矩阵/自审） |
| verifier（durable teammate） | deepseek-v4.1-flash | `verification.md`（6 条事实裁决 + 对抗式复核 + 终版复核） |
| Lead | deepseek-v4.1-flash | 本汇总 + 最终裁决 |

> 注：首次「Gemini 咨询」因 Lead 漏传 `provider`/`model`，实际跑在默认子路由上，其草稿已被真实 Gemini 运行覆盖；对抗式复核中针对旧稿「指针 + shim」的 R1/R2 因此已被终版复核取代。

---

## 2. 已核验的事实（三方一致，附证据）

| 事实 | 证据 | 裁决 |
|---|---|---|
| `/app/.dsh-versions-cache` 不在任何持久化面内 | `Dockerfile:365` VOLUME 仅 4 项；`docker-compose.yml:56-64`、`docker-compose.market.yml:53-61` 同样 4 项 bind mount | FAIL（缓存会随容器消失） |
| 前端切换确认弹窗早已存在，且已区分「本地快照 / npm 下载」 | `gateway/public/admin.html:2209-2318`、`:3649-3651`、`:2311-2315`；`CHANGELOG.md:235` | PASS（**加弹窗 = 重复建设**） |
| 配置/会话快照不含核心 npm 包，对「回切要重新下载」零帮助 | `gateway/backup-service.js:236`（`tar -C /root .dsh`） | FAIL（与诉求无关） |
| 核心体积 538MB / 28,791 文件；`cp -a` 实测 ≈1.4–1.6s | `du -sh` + 容器内实测 | PASS（Gemini 报 4.636s → **UNVERIFIED**，本机快约 3 倍） |
| 既有切换流程的工程缺陷 | 裸 `spawnSync` 不检查返回码 `dsh-manager.js:968,983,1077,1130`；先 `rm -rf` 活动核心再 `cp -a` `:983`；弱判据 `:376,:966` | PASS（全部复现） |

---

## 3. 关键架构裁决：活动核心 = 拷贝 + 原子 rename（**不采用**指针 + shim）

Gemini 与 verifier 在**结论上一致**：采用 **方案 B —— 活动核心保留在容器层 `/usr/local/lib/node_modules/@deepseek-ai/dsh`，版本存储库独立持久化，切换走 Staging 复制 + POSIX 原子 `rename`**。

理由（verifier 已修正 Gemini 的论据强度）：

1. **软链拓扑**：`Dockerfile:289-293` 在全局目录建立了 **277 个**软链（Gemini 称「80 多个」，低估）；插件软链 `Dockerfile:314` 与 `install-plugin.mjs:231-264` 均硬编码全局路径。
2. **镜像更新语义**：若活动核心由卷内指针控制，`pull && up -d` 后新镜像内置的核心会被架空（「僵尸核心」）；且旧 ABI 原生模块（`node-pty`）会 `NODE_MODULE_VERSION` mismatch。**这条是采用 B 的决定性理由。**
3. ⚠️ **修正**：Gemini 的「致命裂脑 / 指针方案不可行」被夸大——shim 下主进程 `require` 从自身 `node_modules` 解析（`entrypoint.sh:26` 的 `NODE_PATH` 只是兜底），偏斜只影响**外部插件**，可缓解。故 A 是「可行但更差」，不是「不可行」。
4. 代价：方案 B **不持久化活动版本**，任何容器重建（含 `restart`）都会回到镜像核心，需用户重新点一次切换（≈1.4s）。这一点须在文档/UI 中明说。

---

## 4. 落地前必须补齐的 5 个洞（来自 verifier 终版复核）

1. **store 只按版本号命名 → 跨镜像碰撞**：v0.1.7 与 v0.1.8 都烤入 `0.1.7-rc.1`（`version.json`），同名目录会被误复用、`pinned` 指向陈旧内容。→ key 需加入**镜像 revision 或内容摘要**。
2. **Gemini §5 risk-1「镜像更新检测」近乎空转**：它靠 `supply.dshVersion` 是否变化判断镜像更新，而镜像更新常不改该值；方案 B 下活动核心本就在容器层，**不存在需要检测的持久化 active 指针**。→ 删除或改为显式版本裁决。
3. **换目录瞬间旧 DSH 进程仍在运行**：阶段 3 做 swap、阶段 5 才 restart；`renameSync` 后旧进程惰性 `require` 会加载新树。→ **先停进程再 rename**。
4. **磁盘预检只查 overlay**：`statfsSync('/usr/local/lib/node_modules/...')` 未覆盖 store 卷。→ 两处都要查。
5. **`.ready` 全量 sha256 校验成本**（538MB / 28.8k 文件）未计入「秒级」预算。→ 采样校验或校验和清单 + 异步校验。

### 另需修正 Gemini 备忘中 2 处错误论断
- §4.3「存储库归档的是纯净代码」**不成立**：阶段 2 归档的是**已被 `entrypoint.sh:93-100` 打过补丁的活动核心**（`patch-dsh-client.mjs` 幂等，风险低，但「两层职责分明」的论断是双标）。
- §3.1.1「打包数 GB 会击穿 `MAX_UPLOAD_BYTES=300MB`」**不成立**：该限制只用于**导入上传**路径（`backup-service.js:522`），创建快照无此限制。（结论「别放 `/root/.dsh`」仍正确。）

---

## 5. 推荐实施计划

**Phase 1 — 持久化就绪**
- **最终采用「复用快照卷」方案**：版本库默认落在 `$DSH_SNAPSHOTS_DIR/versions`（即 `/root/.dsh-snapshots/versions`），**复用现有 `./data/snapshots` 挂载，不新增挂载点**（挂载数保持 4 个）。
  - 依据：版本归档是**惰性缓存**——代码里除 `installVersion()`（切换）外，只有展示/统计/GC 辅助方法会读它，**启动流程完全不读**；因此它随时可被删除，代价仅是该次回切重新下载。失败模式良性 → 无需独立卷保护。
  - 复用快照卷的额外好处：`SNAPSHOTS_DIR` 只被用于读写单个 `*.tar.gz`（`backup-service.js:595` 只列顶层 tar.gz、`:632` 单文件删除），**没有任何整目录清空逻辑**，且恢复流程只动 `/root/.dsh`，因此**不需要修改 backup-service 任何代码**。
  - 代价（已知并接受）：该目录在"快照与备份"面板中不可见（`listBackups` 只列顶层 `*.tar.gz`）；跨机器拷贝快照目录会带上引擎二进制（但 `.ready` 的 `nodeAbi`/`arch` 校验会让它在新机器上**被拒绝使用**，只浪费空间、不会误加载）。
- 需要独立隔离的用户仍可用 `DSH_VERSIONS_DIR` 指到自建卷，例如 `-v ./data/versions:/root/.dsh-versions -e DSH_VERSIONS_DIR=/root/.dsh-versions`。
- `dsh-manager.js` 的 `versionsCacheDir` 从 `/app/.dsh-versions-cache` 迁出。**切勿放进 `/root/.dsh`**（会被 `backup-service.js:236` 打进配置快照、被恢复流程 `:376/:439` 清空）。
- **引擎归档改为「用户选择」**（最终决策）：切换前弹窗新增勾选项「归档当前引擎（约 477MB）」，**默认勾选、可取消**；归档的对象是**被离开的那个版本**（这样日后切回它才免下载）。
  - 取消后系统**不在后台自动归档**：下载新版本不再归档、切换成功也不再归档（`/api/dsh/install` 的 `archiveCurrent` 参数控制）。
  - 代价（已知并接受）：不勾选时，日后手动切回该版本需重新下载（~40s，需联网）。

**Phase 1.5 — 让「归档可选」不削弱安全网**
- **回滚点延迟清理**：`_atomicSwapCore` 不再在置换后立即删除回滚点，而是**保留到健康探活通过**；探活失败时直接从回滚点本地秒级还原（**不联网、不依赖归档**）。
- 效果：熔断回滚与版本归档彻底解耦——归档退化为纯用户功能，用户取消勾选也不会让容器陷入"回滚失败且无核心可用"。

**Phase 2 — 健壮性与原子置换**
- 引入检查返回码的 `execSyncSafe`，替换 `:968/:983/:1077/:1130` 的裸 `spawnSync`。
- **废弃「先删后拷」**：复制到同文件系统 `.dsh-staging-<pid>` → 校验 → `renameSync` 两阶段原子置换；失败立即回滚，现网核心毫发无伤。
- `.ready` 就绪标记（含 sha256、`nodeAbi`、`arch`、镜像 revision）取代 `existsSync('package.json')` 弱判据；修复 `:966` 脏目录永久阻断回滚点的问题。
- **先停 DSH 进程再 rename**；磁盘水位预检覆盖 overlay 与 store 卷两处。

**Phase 3 — 治理与前端**
- 新增 `GET /api/dsh/versions/stats`、`POST /api/dsh/versions/gc`、`DELETE /api/dsh/versions/:version`（拒绝删除活动版与镜像内置版；参数复用 `dsh-version.js` 的 `isValidVersion` + `resolveWithinDir`）。
- LRU 保留 3 份（活动版 + 镜像出厂版 pinned + 上一回退版），默认上限 5 份。
- `admin.html:2229-2231` 把「部署获取方式」改为「⚡ 本地快照秒级还原（约 1.4s）」/「🌐 npm 下载（约 540MB）」+ 磁盘余量与已归档版本数；版本中心增加「本地已归档版本」卡片（体积/时间/状态/删除/GC）。注意旧文案 `< 1s` 是虚假承诺，应一并修正。

---

## 6. 验收测试建议

- 容器重建（`docker compose down && up -d`）后，切回已归档版本**不联网**、端到端 ≤2s。
- 磁盘写满时切换**干净中止**，现网旧版仍可正常服务。
- 人为制造半成品归档目录（只留 `package.json`），确认**不会**被判定为有效缓存、不会被部署。
- `restart` / 镜像更新后行为符合「镜像优先」语义且不静默跑旧版。
- GC 严格保留活动版与镜像出厂版，且能回收 `.invalid-*` 幽灵目录。

---

## 7. 本方案不解决的问题

- DSH 上游会话格式单向迁移（0.1.5 V3 / 0.1.7 V4 不可逆降级）——仍需配置快照。
- 上游破坏性重构导致的客户端补丁锚点漂移——必须拉取新镜像。
- 538MB × N 的去重（需 CAS + 硬链接或 per-version OCI tag，列为 v2）。
- 跨架构卷迁移、慢盘 I/O 衰退（推断项，未实测）。

---

## 8. 实施记录（已落地）

改动文件：

| 文件 | 改动 |
|---|---|
| `gateway/dsh-manager.js` | 版本库迁移到持久化路径 `$DSH_SNAPSHOTS_DIR/versions`（`DSH_VERSIONS_DIR` 可覆盖）；`.ready` 完整性标记；`isReadyVersionDir` 取代 `existsSync(package.json)`；staging + 目录置换取代「先删后拷」；`runSyncSafe` 检查返回码；新增 GC / 删除 / 统计 / 残留清理 / 磁盘水位预检 |
| `gateway/index.js` | 新增 `GET /api/dsh/versions/stats`、`POST /api/dsh/versions/gc`、`DELETE /api/dsh/versions/:version` |
| `Dockerfile` | 无卷变更（挂载点保持 4 个） |
| `docker-compose.yml` / `docker-compose.market.yml` | 无卷变更；新增可选环境变量 `DSH_VERSIONS_MIN_FREE_MB` |
| `scripts/entrypoint.sh` | 启动对账（活动核心缺失时从回滚点恢复）、过期 staging/rollback 清理、持久化自检告警（检查版本库是否落在任一挂载点内） |
| `gateway/public/admin.html` | 去掉虚假的「< 1s」文案 |
| `scripts/version-store-test.mjs` | 新增 45 项单元测试 |
| `scripts/remote-verify-issue7.sh` | 新增远程端到端验证脚本 |

### 8.1 真实容器实测暴露的两个问题（设计备忘未预见）

1. **overlayfs 不允许 rename lower 层目录**（`EXDEV: cross-device link not permitted`）。
   活动核心 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 在容器启动后位于镜像只读层，Gemini 备忘与初版实现所依赖的「POSIX rename 原子置换」在真实容器里**首次切换必然失败**。
   → 修复：`moveDirOrCopy()` 捕获 `EXDEV` 后退化为「`cp -a` + `rm -rf`」（仅每个容器世代首次切换会命中该分支，之后目录已在上层，rename 直接可用）。

2. **npm 临时前缀清理时机错误**（自身引入的缺陷）。
   把清理放在归档之后、staging 构建之前，会先删掉 `sourceDir` 的父目录，导致随后 `cp` 到 staging 时报「没有那个文件或目录」——**下载路径 100% 失败**。
   → 修复：改在 staging 就绪之后（或异常分支）清理。

3. **`try` / `catch` 作用域陷阱**（自身引入的缺陷，最隐蔽）。
   `let tmpPrefix` 声明在 `try` 块**内部**，而 `catch` 块是**兄弟作用域**，看不到 `try` 内声明的变量。于是只要 `try` 里发生任何失败，`catch` 首句 `if (tmpPrefix)` 就抛 `ReferenceError`，把真实错误（如「磁盘空间不足」）**完全掩盖**。
   前几轮验证之所以全绿，是因为那些运行从未进入 `catch` 分支；直到 ENOSPC 演练故意制造失败才暴露。
   → 修复：`tmpPrefix` 提升到 `try` 之外；并新增回归测试 `[J]` 专门覆盖「早期失败必须返回错误对象、且日志保留真实原因」。

### 8.2 额外增强

- 下载后对 `node-pty` 执行 `npm rebuild`（对齐 Dockerfile 构建期行为，避免在线切换后终端原生模块缺失）。
- 磁盘水位预检同时覆盖版本库卷与容器层；失败时**不触碰现网核心**，直接返回 `untouched: true` 并跳过熔断回滚。
- 切换进行中拒绝并发 GC / 删除。
- `.ready` 额外记录 `fileCount` / `sizeBytes`，便于诊断归档完整性。

---

## 9. 远程实测结果

环境：远程 `ubuntu-docker` / x86_64，容器 `deepseek-harness-market`，镜像由 `./build.sh --market` 重建。
验证脚本：`scripts/remote-verify-issue7.sh`（可复现，最终 **PASS=26 / FAIL=0 → ISSUE7_VERIFY_OK**）。

关键结论：

- **存储位置**：版本库落在 `/root/.dsh-snapshots/versions`（复用快照卷），**容器挂载点仍为 4 个**（脚本断言 `{{len .Mounts}} == 4`）；`stats` 报告 `dir: /root/.dsh-snapshots/versions`、`persisted: true`。
- **容器重建后回切免下载**（Issue #7 核心诉求）通过：`docker compose down && up -d` 后归档仍在，切回目标版本命中 `[免下载]`、耗时 ~8s、**零 npm 下载**。
- **手动归档模型**通过：
  - 勾选归档 → 归档的是**被离开的版本**（切换前版本 `0.1.7-rc.1` 落库并带 `.ready`）；**目标版本不会因下载而被自动归档**。
  - 不勾选归档 → 日志出现「未勾选 → 跳过」，且**版本库内容前后完全不变**（证明没有后台自动归档），同时切换仍然成功。
- **回滚点生命周期**通过：成功切换的日志出现「探活通过，已清理切换期间的回滚点」，且切换后容器内**无 `.dsh-rollback-*` 残留**。
- **半成品归档拒用**通过：手工制造只含 `package.json`（无 `.ready`）的目录，切换日志出现「归档不完整，已忽略并改为重新下载」，且不会被当作可用缓存部署。
- **ENOSPC 安全闸门**通过：把 `DSH_VERSIONS_MIN_FREE_MB` 抬到不可满足后，切换被拒绝（「磁盘空间不足」），日志出现「无需熔断回滚」，**服务保持 healthy、核心版本未变**。
- **治理 API** 通过：stats 报告 `persisted: true`；GC dryRun 正确；删除活动版本 / 出厂基准版本 / 目录穿越均被拒绝。
- **安全熔断**通过：对 npm 上已不可安装的版本（如 `0.1.7-alpha.1`，其依赖 `@deepseek-ai/dsh-client-resources@0.1.7-rc.2` 缺失）切换时，下载失败被正确捕获并回滚，容器未受影响。
- 容器内 `version-store-test.mjs` **57/57** 通过（含 `[J]` 早期失败路径、`[K]` 静态作用域守卫、`[L]` 原子置换 / 回滚点生命周期 / **EXDEV 降级**）。

### 9.2 依据 verifier「手动归档与回滚点延迟清理」复核的修补

- **置换阶段抛错也保留回滚点**：`_atomicSwapCore` 在「暂存原核心」失败时把已生成的 `backupDir` 挂在 `err.rollbackDir` 上，`installVersion` 的 catch 接管它做兜底还原（此前会退化为多余的归档/npm 回滚）。
- **回滚异常时的两级兜底**：`catch (rbErr)` 先尝试从回滚点还原，再在核心文件仍存在时**尽力重新拉起服务**（避免"核心在却不可用"），并在返回里带上 `hint`。
- **测试补强**：`[L]` 新增 EXDEV 降级用例（注入一次 `EXDEV` 让 `rename` 失败，验证自动退化为复制+删除、回滚点仍是完整旧核心、且能从中还原）。
- **陈旧引用清理**：`dsh-manager.js` 顶部注释与 `dsh-version-validation-test.mjs` 的基准路径均改为 `$DSH_SNAPSHOTS_DIR/versions`。

> 实测同时验证了「先 staging 再置换」的价值：下载 / 校验 / 归档任一环节失败，现网核心都未被触碰。

### 9.1 最终加固（依据 verifier 终版复核）

- 磁盘水位预检**前置**到阶段 1 之后（归档旧版与下载新版都会写版本库卷，提前拦截可避免白下载 540MB）。
- 下载归档的临时目录改在 `try` 之外声明，并在失败分支清理（避免同类作用域陷阱与临时目录泄漏）。
- 新增 `[K]` 静态守卫测试：断言 `stagingDir` / `tmpPrefix` / `coreMutated` 必须在主 `try` 之前声明，防止该类 bug 再次出现。
