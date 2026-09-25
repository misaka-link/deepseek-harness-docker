# Issue #7 — 独立事实核验与对抗式复核

- 核验者：verifier（独立于 Lead / Gemini，不采信任何一方摘要）
- 方法：只读命令（`read` / `grep` / `du` / `df` / `mount` / `sed` / `node -e`）+ 逐行核对引用
- 工作树：`/workspace/deepseek-harness-docker`，commit `db57c70`（v0.1.8），运行环境为容器内（`/.dockerenv` 存在）
- 被审对象：`doc/issue-7/design-gemini.md`（242 行，13:43 生成）
- 结论标记：**PASS = 该命题经证据确认；FAIL = 命题被证伪；UNVERIFIED = 证据不足**。每条先给结论句，再给证据。

---

## 事实 1：`/app/.dsh-versions-cache` 是否跨 `docker compose down && up` 与镜像更新持久化？

**Verdict: FAIL（作为持久化机制不成立 —— 它不在任何持久化面内）**

证据链（三条独立证据，全部指向同一结论）：

1. 目录硬编码且运行时创建于容器可写层：`gateway/dsh-manager.js:149` `this.versionsCacheDir = '/app/.dsh-versions-cache';`，`:165` 构造时 `fs.mkdirSync(...)`。仓库内除该处与测试 `scripts/dsh-version-validation-test.mjs:52-54` 外无任何其它引用（`grep -rn "dsh-versions-cache"`）。
2. 镜像声明的卷不含 `/app`：`Dockerfile:365` `VOLUME ["/root/.dsh", "/root/.dsh-snapshots", "/workspace", "/root/.config/chromium"]`。
3. 两份 compose 的 `volumes:` 同样只有四项，且都是 bind mount，没有 `/app`：`docker-compose.yml:56-64`（`./data/dsh:/root/.dsh`、`./workspace:/workspace`、`./data/snapshots:/root/.dsh-snapshots`、`./data/browser:/root/.config/chromium`）、`docker-compose.market.yml:53-61`（同四项）。
4. 入口脚本也只创建/维护这四个路径：`scripts/entrypoint.sh:52`（`mkdir -p "${DSH_WORKSPACE}" "${DSH_DIR}" "${DSH_SNAPSHOT_DIR}" "${CHROME_USER_DATA_DIR}" "/tmp/dsh-desktop"`），全文无 `.dsh-versions-cache`。
5. 运行期实测：`mount` 显示 `/` 为 overlay（`upperdir=.../snapshots/1052/fs`，即容器可写层），而 `/workspace`、`/root/.dsh`、`/root/.dsh-snapshots` 是宿主 bind mount（`/dev/mapper/ubuntu--vg-ubuntu--lv`）。`/app` 未出现在任何 mount 条目中 → 属于 overlay 可写层。

推论：`docker compose down` 删除容器即丢弃可写层；`docker compose pull && up -d` 以新镜像新建容器，可写层同样归零。镜像构建也未预置该目录（`grep -n "^COPY\|^ADD" Dockerfile` 只 COPY 了 `plugins.market.list / version.json / scripts/ / gateway/ / plugins/`，见 `Dockerfile:305,336-339`）。**`docker compose restart` 例外**（复用同一可写层），但项目自身推荐的更新路径是 `pull && up -d`（`gateway/public/admin.html:2290`）。Gemini 的同一结论（design §1.1）**成立**。

---

## 事实 2：容器内缓存是否让「切回」真正秒级？逐段追踪 `installVersion()`

**Verdict: FAIL（不是秒级；且存在多条可证伪的静默失败路径）**

命中缓存的分支（`gateway/dsh-manager.js:981-988`）执行的是 `rm -rf 核心目录` → `mkdir -p` → `cp -a 缓存/. 核心/` → `ln -sfn`。这**不是**指针切换，而是对整棵核心树（含 `node_modules`）的一次全量磁盘拷贝。具体失效点（全部有行号）：

- **(a) `spawnSync` 返回码全部被忽略，失败仍打印成功。** 阶段 2 快照 `:968-969`；阶段 3 命中部署 `:983-986`；成功归档 `:1077-1078`；回滚还原 `:1130-1133`。四处均无 `status/error` 检查，随后 `:987` 无条件打印「✔ 核心文件与软链已完成秒级还原 (耗时 < 1s)」。最坏组合：`:983` 先 `rm -rf` 掉当前核心，`:985` 的 `cp` 一旦失败（ENOSPC/EPERM/被 SIGTERM 打断），容器内**没有任何可用核心**，只能再赌一次回滚分支的 `cp`（`:1130-1132`）。
- **(b) `cp -a` 非原子，而「缓存有效」的唯一判据是 `package.json` 存在。** `getCachedVersions()`（`:373-383`）仅 `fs.existsSync(path.join(dir,name,'package.json'))`。被中断的拷贝会留下「有 `package.json`、`node_modules` 不全」的目录，它会被：① 列为缓存版本（`:376`）→ ② 经 `/api/dsh/versions` 下发 `cachedVersions`（`:485`）→ ③ 在 UI 标记为「⚡本地快照」与「秒级还原 (< 1s)」（`gateway/public/admin.html:3498,3574,3618,3644,3649-3651`）→ ④ 下次切换被当真部署（`:981`）→ 起不来。（Gemini 关于「package.json 先落地」的排序假设未经验证，见对抗式复核 R4；但即便排序随机，该失效模式依然成立。）
- **(c) 残缺目录永久阻断重新快照。** `:966` 条件是 `!fs.existsSync(prevBackup) && fs.existsSync(核心/package.json)`；`:971-972` 只要目录存在就宣告「✔ 本地已存在稳定版本…具备秒级回滚能力」，永不再刷新。而回滚 `:1128` 又会命中这个坏目录 → 回滚也失败（`:1206-1210`）。
- **(d) `.invalid-*` 幽灵目录会真的被写入且不可回收。** `:964` 在 `previousVersion` 非严格 semver 时把 `prevBackup` 指向 `versionsCacheDir/.invalid-<ts>`；随后 `:966` 认为「不存在」→ `:968-969` 真的 `cp -a` 一份完整核心进去。触发条件确实存在但**罕见**：`getCurrentVersion()` 的兜底路径直接取 `dsh --version` 的原始 stdout 且不校验（`:422-427`）。该目录因含 `package.json` 会被 `getCachedVersions()` 列出（`:376`），`fs.readdirSync` 默认包含点文件。Gemini 此处**成立但概率被夸大**（见 R5）。
- **(e) 无任何保留策略/GC/删除接口。** 全仓库对 `versionsCacheDir` 只有读与写（`:149,165,375-377,961,964,980,1127`），无删除、无容量上限、无水位保护 → 缓存只增不减。
- **(f) 「< 1s」是写死的常量，不是实测值。** `:987` 与 `gateway/public/admin.html:3650` 均硬编码 `< 1s`。冷页缓存下 `cp -a` 538MB/28,791 文件不可能 <1s；即使热缓存，`cp` 仍需创建 2.8 万个 inode 并写出 538MB。（本轮实测见事实 3 与文末限制说明。）

另：阶段 5 归档新版本的条件是 `!fs.existsSync(targetCached)`（`:1075`），同样只看目录存在性，不看 `package.json` —— 一个半成品目录会让新版本**不被归档**，导致下次切回仍走 npm 下载。

---

## 事实 3：真实体积与合理保留策略

**Verdict: PASS（实测）**

```
$ du -sh /usr/local/lib/node_modules/@deepseek-ai/dsh
538M
$ du -sh /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules
538M
$ find /usr/local/lib/node_modules/@deepseek-ai/dsh | wc -l
28791
$ df -h /app /
Filesystem      Size  Used Avail Use% Mounted on
overlay          96G   51G   41G  56% /
```

- **单版本拷贝成本 ≈ 538 MB / 28,791 个文件**，且 538M 全部在 `node_modules` 内（无共享层，硬链接/去重空间最大）。
- `df` 显示 `/app` 与 `/` 同属一个 overlay（41G 可用），即当前缓存写在**可写层**——不仅会随容器重建丢失，还会持续推高容器层体积。
- 合理保留策略：默认 `keepN=2`（当前 + 上一稳定版）≈ 1.1 GB；硬上限 3~5 份 ≈ 1.6~2.7 GB；GC 触发点 = 每次成功切换后 + 容器启动对账时；水位保护 = 卷剩余 < 2×单版本体积即拒绝新增归档并告警。**必须把仓库放到持久化卷**（`./data/versions` 之类），否则体积/GC 讨论无意义。

> 限制说明：受本次委派写权限约束（唯一可写文件为本文件），未做 `cp -a` 端到端计时。只读基准：`tar -cf /dev/null` 全树热缓存读耗时 `real 0m0.104s`，这只证明读吞吐（页缓存命中），**不含** 538MB 写入与 28,791 次 inode 创建，故不能用来支持「<1s」。

---

## 事实 4：安全 —— `gateway/dsh-version.js` 校验与新持久化仓库的穿越/注入风险

**Verdict: PASS（现有校验充分）；新仓库需按下列约束加固**

现有实现（`gateway/dsh-version.js`）：

- `isValidVersion`（`:14` 正则，`:16-21` 函数）：严格 semver `^\d{1,5}\.\d{1,5}\.\d{1,5}(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+...)?$`，并拒绝长度 0 或 >64。天然拒绝 `/`、`..`、空白、`npm:` 别名。
- `resolveWithinDir(baseDir,name)`（`:30-38`）：`path.resolve` 后强制 `target === base || target.startsWith(base + path.sep)`，越界抛错。
- 双重把关：API 入口 `gateway/index.js:588`（`if (!dshManager.isValidVersion(version))` 返回 400），方法内 `gateway/dsh-manager.js:897` 再校验一次；三处 `path.join` 前都过 `resolveWithinDir`（`:961,980,1127`）。
- 测试覆盖：`scripts/dsh-version-validation-test.mjs:52-54` 断言正常版本落域内、`a/../b` 归一化后仍在域内。

新持久化仓库的增量风险与必要护栏：

1. **路径穿越**：新增 `DELETE /api/dsh/versions/:version`、GC、`index.json` 索引项等所有以 version 为名的路径拼接，必须继续 `isValidVersion` + `resolveWithinDir`，base 固定为仓库根；`index.json` 内的字段不可信（可能被手改），读取后仍需重校验。
2. **符号链接/完整性**：仓库若位于可被其它进程写入的位置（尤其 `/workspace` —— 容器内 AI 以 root 运行且可写工作区），攻击者可在 `<version>/` 内植入指向任意路径的软链或篡改 `lib/bin.js`。`cp -a` 会把恶意内容部署到全局核心并被 `dsh` 执行 → 以 root 任意代码执行。**必须**：仓库 root 归 root、`0700`（与 `scripts/entrypoint.sh:71-77` 对 `$DSH_DIR` 的严格权限一致）；命中缓存的部署路径也要校验完整性（不能只在下载路径校验）；拒绝把仓库放在 `/workspace`。
3. **注入**：`npm install -g @deepseek-ai/dsh@${version}` 的说明符注入已被 `isValidVersion` 阻断（这正是该模块注释 `gateway/dsh-version.js:5-12` 记录的历史漏洞）。任何新引入的 `npm pack`/`npm view`/`--prefix` 调用同样必须只接受校验后的版本串。
4. **并发/竞态**：现有 `this.installing`（`gateway/dsh-manager.js:902`）只保护单进程；多进程/多标签并发需文件锁（Gemini §3.2/§3.5 提出的 `.locks/switch.lock` 方向正确）。

Gemini 的 §3.7 与 §3.3（删除接口复用 `resolveWithinDir`、禁止删活动/固定/镜像版本）方向正确，但**遗漏了「缓存命中路径不做完整性校验」**这一缺口（见对抗式复核 R9）。

---

## 事实 5：`admin.html` 是否已有切换前确认弹窗？引用原文

**Verdict: PASS（已存在，且内容相当完整）**

存在 `#switchConfirmModal`（`gateway/public/admin.html:2209-2319`），由 `installSelectedVersion()`（`:3635-3704`）在用户点「安装并切换版本」（`:1737`）后弹出。关键用户可见文本（逐字引用）：

- 标题：`DSH 核心版本切换确认与安全提醒`（`:2215`）
- 来源徽标（`:3649-3651`）：
  - `⚡ 本地快照秒级还原 (< 1s)`（命中缓存）
  - `🌐 npm 镜像下载安装 (预计 15~30s)`（未命中）
- 降级警告（`:2263-2264`）：`⚠️ [版本安全警告] 您正在从 0.1.5+ 系列降级至旧版本！` / `官方说明：0.1.5 起会话数据格式已升级为 V3 且单向不可逆，降级后旧版本 DSH 无法加载 V3 会话记录。请务必在降级前备份快照！`
- 未适配警告（`:2276-2277`）：`⚠️ 未经当前容器镜像特殊深度适配测试` / `目标版本尚未经过本 Docker 镜像针对性联调测试。如切换后遇到启动异常、插件失效或界面异常，请重新切回已适配版本、更新 Docker 镜像或前往 GitHub Issues 反馈交流。`
- 破坏性重构 danger 卡（`:2245-2246`）：`⛔ 严重预警：底层架构重大重构 · 不再兼容在线切换` / `官方该版本调整了底层架构与通信协议，当前 Docker 镜像底座无法直接在线热切换。切勿在线强制切换，否则可能导致容器服务异常！强烈建议直接重新拉取最新 Docker 镜像重新部署。`
- 数据安全卡（`:2302-2303`）：`数据安全与安全熔断保障` / `切换核心会重启服务并重新装配插件。为了确保您的配置安全，强烈建议选择【⭐ 一键备份并切换】自动生成快照。系统全程内置健康探活，若目标版本无法就绪将自动秒级回滚至稳定版本。`
- 按钮（`:2309-2316`）：`去【快照与备份】面板` / `取消` / `跳过备份，确认切换` / `⭐ 一键备份并切换 (推荐)`

结论：**「要不要加一个切换前确认/备份弹窗」这个选项已经被现状覆盖，纯属重复建设。** Gemini §0.2、§5 的判断成立。

---

## 事实 6：`/root/.dsh-snapshots` 的配置/会话快照能否解决上报者诉求？

**Verdict: FAIL（不能；两者对象完全不同 —— 核心 npm 包 vs 配置/会话数据）**

- 快照服务只打包 `/root/.dsh`：`gateway/backup-service.js:236` `tarArgs.push('-cf', tmpPath, '-C', '/root', '.dsh')`，落点 `SNAPSHOTS_DIR = /root/.dsh-snapshots`（`:5,197`）。
- 打包内容排除缓存、可选排除会话（`:212-228`）；是插件/预设/凭据/会话历史，**不含** `/usr/local/lib/node_modules/@deepseek-ai/dsh`。
- 弹窗的「⭐ 一键备份并切换」确实调用快照接口：`gateway/public/admin.html:3787` `fetch(\`${adminBase}/api/snapshots/create\`, {method:'POST', body: JSON.stringify({ name: \`pre-switch-to-${version}\` })})` —— 备份的是**配置**，不是核心包。
- 实测 `/root/.dsh-snapshots` 内为 `dsh-snapshot-*.tar.gz`（93 MB / 270 MB / 76 MB），即 `.dsh` 数据卷归档。

因此：**多问一句「是否备份」对「切回老版要重新下载」零帮助**；上报者的痛点是「核心包被覆盖后要重新拉 538MB」，只有「核心包的持久化 + 版本隔离」才能解决。恢复配置快照也不会恢复核心版本。Gemini §1.4 的判断成立。

---

# 对抗式复核：`doc/issue-7/design-gemini.md`

复核方式：逐条抽查其 `file:line` 引用与事实断言。结论：**整体方向正确、证据密度高（约 30 处引用中绝大多数准确），但存在 1 处实质性设计冲突、1 处关键遗漏、若干夸大/未证实的表述。**

## A. 引用抽查（已核对，准确）

| Gemini 断言 | 引用 | 核对结果 |
|---|---|---|
| 缓存硬编码在 /app，构造时 mkdir | `dsh-manager.js:149,165` | ✔ 准确 |
| /app 未持久化 | `Dockerfile:365`、两份 compose volumes | ✔ 准确（见事实 1） |
| 阶段 2 无条件自动快照、判据仅 existsSync | `dsh-manager.js:955-975`（尤其 `:966,971-972`） | ✔ 准确 |
| 命中 = rm -rf + cp -a；未命中 = npm install -g | `:981-988`、`:989-1029` | ✔ 准确 |
| 归档新版本 / 自动回滚 | `:1074-1079`、`:1115-1210` | ✔ 准确 |
| `getCurrentVersion` 取 `dsh --version` 原始输出 | `:400-431`（`:422-427`） | ✔ 准确，且**确实未校验** |
| npm 用不持久的 /tmp 缓存 | `:449`（`--cache=/tmp/.npm-cache`） | ✔ 准确 |
| 镜像烤入核心、供应链版本、integrity 校验 | `Dockerfile:256-297`、`:274-277`、`version.json:14` | ✔ 准确（`supply.dshVersion = "0.1.7-rc.1"`） |
| 启动重跑装配与补丁，补丁改写核心内文件 | `entrypoint.sh:87-90,93-100`；`patch-dsh-client.mjs:106,125,162,232,256,274,293` | ✔ 准确（七处均为 `fs.writeFileSync`） |
| 配置快照是另一回事 | `backup-service.js:5,197,593-598` | ✔ 准确 |
| 已有防呆弹窗与「秒级/下载」区分 | `admin.html:2209-2318,3635-3704,3498,3644,3649-3651,3532` | ✔ 准确 |
| 适配矩阵 / V3·V4 不可逆 | `version.json:171-204` | ✔ 准确（V3 `<0.1.5-rc.1`、V4 `<0.1.7-alpha.1`） |
| 无 new privileges + cap_drop ALL | `docker-compose.yml:39-51` | ✔ 准确 |
| admin 路由在鉴权之后 | `index.js:548-639` | ✔ 准确（`:1126` `checkRequestAuth` 在 `:1160` 派发之前拦截） |
| gateway 通过 `dsh` 命令拉起核心 | （Gemini 隐含，`dsh-manager.js:578` `spawn('dsh',['web',...])`） | ✔ 成立 → D5' 的 shim 方案在启动链路上可行 |

## B. 错误 / 未证实 / 夸大 / 有风险的断言

- **R1（严重 · 设计自相矛盾）「切换 = O(1) 改指针」与「每次切换后重跑阶段 4 补丁」不能同时成立。** §3.2.5 让活动核心直接就是仓库目录（`active.json` 指针 + shim），但 §3.6/§4.3 又要求每次切换后重跑 `install-plugin.mjs` 与 `patch-dsh-client.mjs`，而这两个脚本**就地改写核心内文件**（已核实七处 `writeFileSync`）。结果是：被切上去的仓库副本会被就地打补丁 → §3.1 宣称的「`<version>/` 完整核心树（不可变）」不成立；且反复切回切出会反复就地补丁（幂等性未验证）。**要么仓库存未打补丁的原始树、活动核心另拷贝一份（又回到 538MB 拷贝），要么接受仓库被污染并放弃「不可变」承诺。** Gemini 未解决这个矛盾。
- **R2（严重 · 关键遗漏）镜像更新后会把用户静默钉在旧版本。** §3.2.7 启动对账「读 `active.json` → 若目标目录 ready 则重指指针；否则回退到镜像烤入版本」。于是用户执行推荐的 `docker compose pull && docker compose up -d` 升级镜像后，容器会**继续跑仓库里的旧版本**，新镜像烤入的新核心被指针遮蔽。这与弹窗自己推荐的升级路径（`admin.html:2290`）直接冲突，也未被列为风险。正确语义应是「镜像烤入版本变化时以新镜像为准，或至少提示用户」，Gemini 未讨论。
- **R3（重要 · 遗漏）持久化仓库版本与镜像共享依赖之间的解析偏斜。** 现有机制把镜像核心的依赖以绝对路径软链进插件目录（`Dockerfile:288-296`：`ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg> /usr/local/lib/node_modules/@deepseek-ai/<pkg>`），且 `entrypoint.sh:26` 把 `NODE_PATH` 写死为镜像核心的 `node_modules`。若活动核心来自仓库（`/root/.dsh-versions/<v>`），插件与 `NODE_PATH` 仍解析到**镜像那份**核心的共享依赖（schemastery 等），旧仓库版本可能与新镜像底座依赖发生版本偏斜。Gemini 只提了 Node ABI（§4.4），未提 NODE_PATH/插件软链偏斜。
- **R4（未证实）「`package.json` 在顶层、通常先落地」**（§1.3b）。`cp -a` 按 `readdir` 顺序复制，无排序保证。结论（残缺目录会被 `getCachedVersions` 当作有效）成立，但该排序论据本身无证据，不应作为推理前提。
- **R5（夸大）`.invalid-*` 被描述为常态泄漏。** §1.3d 说「每次这类切换泄漏一个 ~540MB 目录」。触发前提是 `previousVersion` 非严格 semver，而正常路径（读 `package.json.version`）几乎总是合法 semver；`dsh --version` 输出也通常是纯 semver。应表述为**低概率潜伏缺陷**，而非稳定复现的泄漏。
- **R6（夸大）「缓存命中分支永远走不到」**（§1.1）。在**同一容器生命周期内** A→B→A 是能命中缓存的（阶段 2 会归档 A）。准确表述是「容器重建/镜像更新后走不到」。
- **R7（夸大）「每切一次永久 +540MB」**（§1.3e）。归档仅在目标目录不存在时发生（`:966,1075`）；同一版本重复切换不新增。准确表述是「每个**新**版本归档 +540MB」。
- **R8（未证实）D4 的「~2.7GB 压到 ~1.2GB」**（§2 表）。硬链接去重收益取决于同批子包的实际重复率，无实测支撑，属估计而非结论。
- **R9（安全缺口）缓存命中路径缺完整性校验。** §3.2.5 只在**下载**路径校验 `integrity`；命中仓库分支仅凭 `.ready` 标记即部署到全局核心并执行。仓库一旦被篡改（见事实 4 风险 2），即可 root 代码执行。应在部署前对仓库内容做校验（至少校验 `lib/bin.js` 或记录 `dist.integrity`）。
- **R10（低价值/误导）旧缓存迁移步骤（§3.2.8）近乎空操作。** 迁移的前提是旧 `/app/.dsh-versions-cache/*` 还存在，但 `down`/镜像更新恰恰会清掉它（事实 1）；只有在「同一容器内热更新网关代码」这种场景才有内容可迁。作为 P1 步骤价值有限，宜标注为 best-effort。
- **R11（轻微）行号偏差。** §3.1 称「`docker-compose.yml` 在 `:62` 之后加卷」，实际 `:62` 是注释、`:63` 才是 `./data/browser` 行，应加在 `:63` 之后；`docker-compose.market.yml` 同理（应在 `:61` 之后，而非 `:59`）。`docker-compose.yml:54-55`「非 root」实为 `54` 注释 + `55` 注释（`volumes:` 在 `56`）。不影响结论，但引用精度可提升。
- **R12（未证实但合理）「<1s 是营销数字」**。结论正确（`:987` 与 `admin.html:3650` 是硬编码常量），但 Gemini 未给测量；本核验亦因写权限限制未做端到端 `cp` 计时（见事实 3 限制说明），故「冷缓存至少数秒」只能算合理推断，非实测。

## C. 被 Gemini 遗漏的设计选项 / 视角

1. **不落 538MB 全树，只持久化压缩 tarball / npm cacache**：把 `dist.tarball`（约 100~200MB 级，构建期已在用 `npm pack`，`Dockerfile:270`）持久化，切回时本地解包而非全树拷贝。Gemini 的 D1 只把 npm cache 当「辅助离线兜底」，未评估「以 tarball 为主存储」的体积优势（可省约 3~4 倍磁盘，代价是解包 I/O）。
2. **用 `cp -al`（硬链接）从仓库建活动核心**：切换成本从「复制 538MB」降到「建 2.8 万个硬链接」，秒级且近乎零额外空间；代价是阶段 4 就地补丁会写穿仓库（需 `cp --reflink=auto` 或先打补丁后归档）。Gemini 只在 D4 提了「CAS + 硬链接去重」，未考虑「硬链接即切换手段」。
3. **`docker compose restart` 与 `down/up` 的区别未在方案里利用**：既然 `restart` 保留可写层，最廉价的 P0 修复可以只是「把缓存目录声明为卷」，Gemini 的 P0 也这么做了——但它未指出「在卷不可用/旧版本升级场景下，`restart` 路径本就可命中」，可作为灰度验证手段。
4. **上报者诉求的「隔离」语义**：用户说「把老的版本隔离开来」。Gemini 的方案（单一仓库 + 指针）在**同一容器**内隔离，但没讨论「宿主侧多镜像 tag 并行」（D2 一笔带过）。对追求彻底隔离的用户，D2 或许才是「隔离」的字面答案——值得在给维护者的回答里更明确地二选一。
5. **对上游的诉求**：问题本质也包含「官方 DSH 升级会破坏镜像适配（补丁锚点漂移）」。Gemini §6.1 承认但归为「产品固有问题」；可考虑向 upstream 提议稳定的插件/补丁接口，这属于被遗漏的「非容器侧」选项。

## D. 对 Lead 任务框架（task-1/task-2）的核对

Lead 在 task-2 里给出的 6 条待验证事实**全部与代码实况相符**，未发现 Lead 摘要层面的误导。唯一需要修正的是措辞强度：事实 2 应表述为「不是秒级且有多条静默失败路径」，而不是「缓存完全无效」——在**同一容器生命周期内**缓存命中分支是能工作的。

---

## 最终裁决（供 Lead 决策）

- 上报者体感成立，根因 = 缓存与活动核心都在**非持久化**的容器可写层（事实 1、2）。
- 「加切换前备份弹窗」= 重复建设且无效（事实 5、6）。
- Gemini 推荐「持久化仓库 + 指针式原子切换」的**大方向正确**，但其「O(1) 切换」与「仓库不可变」在阶段 4 就地补丁下**自相矛盾（R1）**，且**漏掉镜像更新后指针遮蔽新核心的语义冲突（R2）**与 **NODE_PATH/插件软链偏斜（R3）**。
- 落地建议排序：**P0 先把缓存目录改到持久化卷（最小改动即可让「切回」跨容器重建命中）**；P1 补原子性/返回码校验/`.ready` 判据；P2 再讨论指针式切换——但**必须同时定义「镜像更新 vs 指针」的优先级**，否则会把用户钉死在旧版本。

---

### 附：无法确认的事项

1. **端到端 `cp -a` 538MB 的实际秒数** —— 受「唯一可写文件为 verification.md」的写权限约束，未落盘做基准测试；只做了只读 `tar -to-/dev/null`（0.104s，热缓存读）。
2. **Gemini「package.json 先落地」的 cp 顺序假设** —— 无证据，仅属推测。
3. **D4 硬链接去重后「~1.2GB」** —— 无实测，属估计。
4. **多进程/多标签并发下 `.locks` 方案的实效** —— 属未来设计，无法在当前代码上验证。

---

# 复核 Gemini 终版备忘（`design-gemini.md` 13:50 版，306 行）

> 说明：Lead 指出 13:43 版已被真实 Gemini 运行覆盖。上文对抗式复核的 **R1/R2 针对的是旧稿的「active.json 指针 + shim」**；终版**明确否决**该流派、改为「活动核心留在容器层 + 卷隔离存储 + 原子 Staging Swap」。以下对终版重新裁决，逐条回应 Lead 的 5 个问题。

## 判定 1：否决「指针 + Shim」（方案 A）—— **PASS（结论可辩护）／FAIL（论据强度被夸大）**

引用核对：`Dockerfile:289-293` 的软链循环 ✔；`Dockerfile:314` 插件软链 ✔（逐字为 `ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai "/usr/local/lib/node_modules/$p/node_modules/@deepseek-ai"`）；`install-plugin.mjs:231-264` 硬编码全局路径 ✔。

但两处论据不成立或夸大：

1. **数量严重低估**：Gemini 称「80 多个子包」，实测 `ls -la /usr/local/lib/node_modules/@deepseek-ai/ | grep -c '^l'` = **277 个软链**（总条目 278）。机制方向对，数字错。
2. **「致命裂脑、指针方案不可行」被夸大**。shim `exec <store>/<v>/lib/bin.js` 时，**主进程的 `require` 从自身包的 `node_modules` 解析**（`entrypoint.sh:26` 的 `NODE_PATH` 只是解析链兜底，不是首选），因此不会出现 Gemini 所述「主程序在 A 跑、内部类库全在 B 找」。真正的偏斜只发生在**外部插件**：`/usr/local/lib/node_modules/<plugin>/node_modules/@deepseek-ai` 与顶层 277 个 `@deepseek-ai/*` 软链固定指向镜像核心。→ 该问题可缓解（切换后重建软链，或让 store 版本依赖自洽），并非不可逾越。
3. 论据 3（bind mount 丢执行位）同样夸大：Linux 宿主 bind mount 保留执行位；`entrypoint.sh:68` 每次启动已 `chmod 0755 spawn-helper` 兜底（Gemini 未提）。

**实质成立**的是论据 2：「镜像更新优先」是正当产品语义（与本文件旧稿 R2 一致）；且「活动核心留 overlay、只持久化 store」确实比把运行目录放卷上更稳。**故方案 B 优于 A，但 A 不是「致命不可行」。**

## 判定 2：`cp -a` 实测 4.636s —— **FAIL（无法复现，数值高估约 3 倍）**

在容器内实测（overlay→overlay，目标 `/tmp`，写后立即删除；源 = 538M / 28,791 文件）：

```
real 0m1.607s   # 第一次（页缓存热）
real 0m1.406s   # 第二次
du -sh /tmp/dsh-cptest-...  →  538M
```

Gemini 的 **4.636s 在本机复现不出来**，高出约 3 倍；可能来自冷缓存、更慢磁盘或不同目标 FS。**该具体数字标记 UNVERIFIED**；但「`cp` 非 <1s、秒级可接受」的方向成立（旧 UI 的 `<1s` 仍是虚假承诺）。

> 限制：我的源是 overlay 而非 bind-mount store（真实切换是 store→overlay），若宿主盘较慢，实际会高于 1.4s，但仍不太可能是 4.6s 级别。

## 判定 3：store 不能放 `/root/.dsh` —— **PASS（核心结论正确）／一处论据错误**

- 打包会扫入：`backup-service.js:236` `tarArgs.push('-cf', tmpPath, '-C', '/root', '.dsh')`；排除项仅 `.dsh/.pnpm-store`、`**/node_modules/.cache`、`.dsh/tmp`、`.dsh/gateway.config.json`（`:212-218`）→ 卷内多份 538MB 版本会被打进配置快照 ✔。
- 恢复会抹掉 store：`:376` `moveChildren(DSH_DIR, rollbackRoot)`，成功后 `:439` `fs.rmSync(rollbackRoot, { recursive: true, force: true })` ✔（Gemini 引用 `:360-379`，实际 `rmSync` 在 `:439`，行号有偏差）。
- **论据错误**：Gemini 称「打包数 GB 会迅速击穿 `backup-service.js:9` 的 `MAX_UPLOAD_BYTES = 300MB` 上限」。实测 `MAX_UPLOAD_BYTES` 只在**导入上传**路径使用（`:522` `if (totalBytes > MAX_UPLOAD_BYTES)`），**创建快照没有该限制**。因果链错误，但不推翻「别放 `.dsh`」的结论。

## 判定 4：`./data/versions:/root/.dsh-versions` + `.ready` + LRU keep-3 —— **PASS（方向合理）／存在 5 个未覆盖的洞**

与镜像更新流程的关系：`entrypoint.sh:87-90`（install-plugin）与 `:93-100`（patch-dsh-client）每次启动对**全局核心路径**执行；方案 B 的活动核心恰是该路径，二者相容 ✔，且 277 个顶层软链与被替换的全局目录自动保持一致（这正是 B 相对 A 的真实优势）。未覆盖的洞：

1. **store 只按版本号命名 → 跨镜像碰撞**。`version.json` 显示 v0.1.7 与 v0.1.8 都烤入 `0.1.7-rc.1`；若镜像更新未改 `supply.dshVersion`（却改了补丁/底座），同名目录会被误复用，「镜像内置版本（pinned）」也会指向陈旧内容。key 需加入镜像 revision 或内容摘要。
2. **§5 risk-1 的「镜像更新检测」不可靠且近乎空转**：它用 `supply.dshVersion` 是否变化来判断「底座镜像更新」，而镜像更新常常不改该值；且方案 B 的活动核心本就在容器层、容器重建即回镜像核心，**根本不存在需要检测的持久化 active 指针**。
3. **换目录瞬间旧 DSH 进程仍在运行**（阶段 3 做 swap，阶段 5 才 restart）：`renameSync` 之后旧进程若发生惰性 `require`，会加载到新树。§5 risk-6 只覆盖「断电/强杀」，未覆盖活体进程。
4. **磁盘预检只查 overlay**：§3.2.3 用 `statfsSync('/usr/local/lib/node_modules/@deepseek-ai')`，未检查 store 所在卷；归档进 store 时卷满不会被拦截。
5. **`.ready` 的全量 sha256 校验成本**（538MB / 28.8k 文件）未计入「秒级」预算。

另：方案 B **不持久化活动版本**，故任何容器重建（含 `docker compose restart`）都会回到镜像核心、需用户重新点一次切换（≈1.4s）。Gemini 全文未明说这一点，读者可能误以为「切过去就一直在了」。

## 判定 5：其余错误 / 未证实 / 风险断言

- **FAIL（错误）§4.3「存储库归档的是纯净代码」**：终版阶段 2（§3.2.2）用 `cp -a /usr/local/lib/node_modules/@deepseek-ai/dsh/.` 归档的是**已被 `entrypoint.sh:93-100` 打过补丁的活动核心**，并非纯净代码。所幸 `patch-dsh-client.mjs` 有幂等标记（`:16,99,147,185,210,269,287` 均先 `includes(...)` 再写），重复打补丁风险低——但「纯净/两层职责分明」的论断不成立，与它自己对旧稿的批判（§4.3）构成双标。
- **夸大 §1.3.5**：称 `.invalid-*`「无法在管理界面列出或清理」。实际 `getCachedVersions()`（`dsh-manager.js:376`）会列出它（它含 `package.json`）；它不出现在下拉框是因为下拉框数据源是上游 `data.versions`（`admin.html:3497`），与 `isValidVersion` 无关。
- **轻微行号偏差 §3.1.1**：`rmSync(rollbackRoot)` 在 `:439`，不在所引 `:360-379`。
- **轻微行号偏差 §3.1.3**：加卷位置应为 `docker-compose.yml:64` 之后、`docker-compose.market.yml:61` 之后，而非文中的 `:62`/`:59`。
- **未证实**：§5 risk-7「跨架构卷迁移」、§7.3「慢盘衰退至数十秒」均为推断，无实测。
- **未证实**：§3.2.2 归档「校验 `<staging>/package.json` 版本字段完全匹配 `previousVersion`」——若 `previousVersion` 来自 `dsh --version` 原始输出（`dsh-manager.js:422-427`，无校验），该匹配可能因输出带前缀/换行而失败，方案未给出归一化。

## 终版总评（供 Lead）

终版备忘的**根因分析、对「加弹窗」的否定、对既有工程缺陷（静默失败 / 先删后拷 / 弱判据）的列举全部正确且有行号支撑**；否决指针方案的**结论可辩护**，但「致命裂脑 / 不可行」的论据被夸大，且 4.636s 无法复现（本机 ≈1.4–1.6s）。落地前应解决 5 个洞，其中 **① store 命名跨镜像碰撞**、**② §5 risk-1 空转**、**③ 换目录瞬间的活体进程** 最关键；另需修正 §4.3「纯净代码」与 §3.1.1「击穿 MAX_UPLOAD_BYTES」两处错误论断。

### 本轮无法确认的事项

1. Gemini 的 **4.636s** 具体环境（本机复现为 1.4–1.6s，差异原因不明）。
2. store→overlay（bind mount 源）的真实拷贝耗时（我未创建 store 目录；本次计时为 overlay→overlay）。
3. §5 risk-7 跨架构、§7.3 慢盘延迟——均无实测。

---

# 复核 Issue #7 修复实现（工作树 `git status`：7 改 2 新，未提交）

- 复核方式：只读读码 + `git diff` + 实跑 `node scripts/version-store-test.mjs`（**29/29 通过**，`store=/tmp/dsh-store-test-*`）。不采信 Lead 摘要。
- 运行环境：Node v24.21.0，`process.versions.modules = 137`，`fs.statfsSync` 可用。
- 改动文件：`gateway/dsh-manager.js`（+438/-55）、`gateway/index.js`（+19）、`Dockerfile`、`docker-compose.yml`、`docker-compose.market.yml`、`scripts/entrypoint.sh`、`gateway/public/admin.html`、新增 `scripts/version-store-test.mjs`。

## 判定 1：`_atomicSwapCore` 原子性与失败还原 —— **PASS（无「先删后拷」窗口）／2 处边界缺陷**

`gateway/dsh-manager.js:1443-1460`：

```js
if (fs.existsSync(LIVE_CORE_DIR)) { fs.renameSync(LIVE_CORE_DIR, backupDir); moved = true; }
try { fs.renameSync(stagingDirPath, LIVE_CORE_DIR);
      runSyncSafe('ln', ['-sfn', path.join(LIVE_CORE_DIR,'lib/bin.js'), DSH_BIN_LINK]); }
catch (e) { if (moved && !fs.existsSync(LIVE_CORE_DIR)) { try { fs.renameSync(backupDir, LIVE_CORE_DIR); } catch {} } throw ... }
if (moved) { try { fs.rmSync(backupDir, ...); } catch {} }
```

- **无先删后拷**：活动核心是 `rename` 到 `.dsh-rollback-<pid>-<ts>`，再 `rename` staging 进占；全程无 `rm -rf` 活动目录 ✔。调用点 `:1213` 先 `await this.stop()` 再 `:1214` swap（**已修掉终版复核 R3「换目录瞬间旧进程仍在跑」**）✔。
- **同文件系统** ✔：staging 与 live 同在 `/usr/local/lib/node_modules/@deepseek-ai/`（`:1201` vs `:146`），rename 不会 EXDEV。
- **失败还原不 100%**（2 处）：
  1. **`ln` 失败不触发还原**。staging 已 rename 成功 → `LIVE_CORE_DIR` 存在 → 条件 `!fs.existsSync(LIVE_CORE_DIR)` 为假 → 不回滚，直接 throw，由 `installVersion` 的 catch（`:1303`）走**整段回滚**。即「`ln -sfn` 失败」会白白回滚一次成功的切换。缓解：`ln` 目标路径与版本无关（恒为 `.../dsh/lib/bin.js`），失败基本无害——但语义上「已还原原核心」的报错信息与实际不符。
  2. **回滚 `rename` 自身抛错被吞**（`:1455` `catch {}`），活动核心会缺失，只能等**下一次容器启动**由 `entrypoint.sh` 1.15.1 自愈（同容器内网关重启不会自愈）。
- **崩溃窗口**：两次 rename 之间 `LIVE_CORE_DIR` 短暂不存在；若此刻容器被杀，恢复依赖 entrypoint 自愈（可接受，非静默丢数据）。

## 判定 2：半成品归档是否会被采用 —— **PASS（所有采用路径均走 `.ready`）**

`isReadyVersionDir()`（`:185-192`）要求 **`.ready` 存在 + `package.json` + `node_modules` 非空 + nodeAbi/arch 匹配**。逐一核对全部路径：

| 路径 | 位置 | 判据 |
|---|---|---|
| `getCachedVersions()`（UI `cachedVersions`） | `:507-511` | `isReadyVersionDir` ✔ |
| `fetchAvailableVersions()` / `getStatus()` | `:481`、`:618` | 同上（唯一数据源） ✔ |
| 阶段 2 复用旧归档 | `:1099` | `isReadyVersionDir` ✔ |
| 阶段 3 命中免下载 | `:1130` | `isReadyVersionDir` ✔ |
| 阶段 5 归档去重 | `:1262` | `isReadyVersionDir` ✔ |
| **熔断回滚** | `:1333` | `isReadyVersionDir` ✔（旧稿的 rollback 弱判据已修） |
| GC | `:1501` | `filter(e => e.ready)` ✔ |

- **`.ready` 的写入时机正确**：`writeReadyMarker(archTmp)` 在 `cp` **之后**、`renameSync` **之前**（`:1112-1114`、`:1190-1192`、`:1267-1269`），因此被 SIGKILL 打断的拷贝**永远不会带 `.ready`**，`isReadyVersionDir` 必判假 ✔。半成品/残留目录位于 `.staging/`（点开头），被 `listStoreEntries()` 的 `name.startsWith('.')` 跳过（`:247`）✔。
- 残留缺口：**没有 sha256/内容校验**。`writeReadyMarker`（`:194-205`）只写 version/nodeAbi/nodeVersion/arch/imageRevision/createdAt——**无哈希**。Lead 所说「.ready 完整性签名」名不副实；被篡改的归档只要 `.ready` 字段匹配就会被部署。这正是我上轮 R9 的缺口，尚未闭合。

## 判定 3：GC 的 LRU 语义与 `_touchVersionUsage` —— **PASS（无自相矛盾）**

`gcVersions()`（`:1500-1523`）：`keep = 按 mtimeMs 倒序取 keepN` **∪** `{activeVersion}` **∪** `{FALLBACK_DSH_VERSION}`。因此**活动版本与镜像出厂基准版本永不会被误删** ✔（测试用例 E 亦覆盖：`GC 保留了活动版本`、`GC 永不清理镜像出厂基准版本`）。

- `_touchVersionUsage`（`:1430-1436`）用 `fs.utimesSync(dir, now, now)` 改目录 mtime；`listStoreEntries` 读的正是 `fs.statSync(dir).mtimeMs`（`:250,257`）→ **同一时间基准，不自相矛盾** ✔。阶段 2 会 touch「即将离开的旧版」、阶段 3 touch 命中版本，二者都是「最近使用」的合理语义。
- 轻微：GC **未显式保护「上一回退版本」**，仅靠它刚被 touch 而进入 top-N；若用户用 API `keepN=1` 手动 GC，回退点可能被清（用户主动操作，可接受）。
- 轻微竞态：`gcVersions`/`deleteCachedVersion` 不检查 `this.installing`，也不与安装串行化。若某次安装在下载阶段停留 >1h，`cleanupStagingOrphans(maxAgeMs=1h)` 可能回收其 staging；`DELETE` 也可能删掉正在被 `cp` 读取的源归档（失败即中止，不伤活动核心）。低概率，建议 GC/DELETE 复用 `installing` 互斥。

## 判定 4：ENOSPC 与垃圾残留 —— **PASS（不伤活动核心）／FAIL（会留垃圾）**

- **先建 staging、后停进程、再 swap**：`cp -a` 到 staging 在 `:1204`，`await this.stop()` 在 `:1213`，swap 在 `:1214`。磁盘满 → `runSyncSafe` 抛错（`:166-169`）→ catch `:1305` 删 staging → 回滚。**活动核心全程未被触碰** ✔（旧实现的「先 rm -rf 再 cp」已消除）。
- **无磁盘预检**：全文件仅 `:1469` 一处 `statfsSync`（且只用于 stats 展示）。设计备忘承诺的「写前水位预检」**未实现**——功能上安全（cp 会失败），但错误信息不友好，且阶段 2 往 store 卷归档时卷满不会被提前拦截。
- **垃圾残留（真实缺陷）**：`tmpPrefix`（`:1140`，`npm install --prefix` 的完整 538MB 产物）**只在 npm 失败时删除**（`:1177`）；下载+归档成功后**从不删除** → 持久卷 `.staging/` 里长期滞留一份完整核心，直到 `cleanupStagingOrphans`（>1h，`:1526`）或下次 GC 才回收。另：下载后归档失败分支（`:1194-1196`）也不删 `archTmp`。建议：成功归档后立即 `rmSync(tmpPrefix)`，归档 catch 里补 `rmSync(archTmp)`。

## 判定 5：entrypoint `.dsh-rollback-*` 自愈与 `mmin +60` —— **PASS（不会搬走进行中的切换）**

`scripts/entrypoint.sh:88-113`：

- 自愈块仅在 `[ ! -d "${CORE_DIR}" ]` 时执行，且**只在容器启动时跑一次**（entrypoint 是网关的父进程，此刻不可能有「进行中的切换」）→ 不会误搬进行中切换的回滚点 ✔。
- **顺序正确**：1.15.1 自愈 → 1.15.2 清理，避免「先删回滚点再想恢复」✔。`sort | tail -1` 按 `<timestamp>` 取最新回滚点（`Date.now()` 定长，字典序≈时间序）✔。
- `mmin +60` 安全：进行中的 staging 必然 <60min，不会被删 ✔。清理只匹配 `CORE_PARENT` 下的 `.dsh-staging-*` / `.dsh-rollback-*` 与 store 的 `.staging/*`，**绝不触碰 `dsh` 活动目录** ✔。
- 残留风险：若自愈的 `mv` 失败（权限/EXDEV），随后 `>60min` 的清理可能删掉最后一个回滚副本。极低概率，可加「自愈失败则跳过清理」的保护。
- 一致性 ✔：`awk '{print $5}' /proc/self/mountinfo`（mountpoint）与 `dsh-manager.js:231-239 isMountedPath` 的字段索引一致，均正确。

## 判定 6：新增安全面 —— **PASS**

- `DELETE /api/dsh/versions/:version`（`gateway/index.js:580-585`）：`decodeURIComponent` 后先拒 `/`，再进 `deleteCachedVersion` → `isValidVersion`（严格 semver，拒 `..`/分隔符/`npm:`）+ `resolveWithinDir`（`:1547,1552`）。`..%2F`、绝对路径、反斜杠均被挡 ✔。`decodeURIComponent` 对畸形输入（如 `%`）抛错会被 `handleAdminApi` 外层 catch（`index.js:926`）兜成 500，不会崩进程 ✔。
- 三个新路由都位于 `handleAdminApi` 内，**位于 `checkRequestAuth`（`index.js:1126`）之后** ✔；stats 仅泄露 store 路径/体积/时间，无凭据 ✔。
- 残留（非本次引入的新风险）：这些写操作与既有 `/api/dsh/install` 一样**无 CSRF token**（依赖 SameSite/Session），且未与 `installing` 串行化。

## 判定 7：漏改 / 一致性 —— **FAIL（轻微）**

- `scripts/dsh-version-validation-test.mjs:52-54` **仍以 `/app/.dsh-versions-cache` 为基准路径**（只测 `resolveWithinDir` 纯函数，不影响运行，属陈旧引用）。
- `CHANGELOG.md` **无本次架构变更条目**（仓库约定「重要修复与架构变更均记录于此」，v0.1.8 段未动）。
- `README.md` 无关于版本库路径的陈旧断言（仅有的「秒级快照备份」指配置快照，仍准确）✔；`gateway/public/admin.html` 中 `< 1s` 文案已全部清除（`grep` 无残留）✔。
- 非 root 部署：compose 挂载 `./data/versions:/root/.dsh-versions`，但 `DSH_HOME=/home/dsh` 时 store 默认解析为 `/home/dsh/.dsh-versions`，该挂载不覆盖（与既有 `.dsh` 挂载同款既有问题，非本次新增）。

## 修复实现总评（供 Lead）

核心诉求已落地且**方向正确**：持久化卷（`Dockerfile:365` + 两份 compose + `DSH_VERSIONS_DIR`）、`.ready` 全路径门禁、**先 staging 后 rename 原子置换**（已无先删后拷、已先停进程）、`runSyncSafe` 检查返回码、rollback 改走 `.ready` 归档、GC 保护活动版与出厂版、DELETE 防穿越——**1/2/3/5/6 判定均 PASS**，29/29 单测通过。

需在合并前修掉的 3 项：
1. **`tmpPrefix` 泄漏**（判定 4，每次联网安装往持久卷漏 538MB 垃圾，且 1h 内不回收）。
2. **`.ready` 无内容哈希**（判定 2），「完整性签名」名不副实；被篡改的归档会被部署。
3. **`ln` 失败触发整段回滚 / 回滚 rename 失败被吞**（判定 1），建议把 `ln` 移出回滚触发条件，并在自愈失败时跳过清理。

另建议补：磁盘水位预检（设计承诺未实现）、CHANGELOG 条目、`dsh-version-validation-test.mjs` 的陈旧基准路径、GC/DELETE 与 `installing` 互斥。

### 本轮无法确认的事项

1. **端到端原子置换 / 回滚 / ENOSPC 的真实行为**——需要在真实容器里切版本才能触发（会改动 `/usr/local/lib/node_modules`，超出我的写权限）；本次仅静态读码 + 单测（单测不覆盖 `_atomicSwapCore`，`grep` 确认测试文件未引用它）。
2. **`cp` 在真实 store（bind mount）→overlay 的耗时**——未建 store，未实测。
3. **`_touchVersionUsage` 在非 root bind mount 上的写权限**——理论受宿主 uid 影响，未实测。
4. **CHANGELOG/README 是否属于本次交付范围**——只报事实，不判是否故意。

---

# 终版复核（Issue #7 修复的第二次对抗式复核）

- 方法：重读当前工作树代码（不沿用上轮结论）+ 实跑两套测试。**`node scripts/version-store-test.mjs` → 39/39 PASS**（含新增 `[J]` 回归）；**`node scripts/dsh-version-validation-test.mjs` → 34/34 PASS**。
- `git status`：11 改 2 新（新增 `README.md`、`CHANGELOG.md`、`scripts/dsh-version-validation-test.mjs` 的改动）。

## A. `try`/`catch` 作用域残留 —— **PASS**

- `stagingDir` / `tmpPrefix` / `coreMutated` 均在 `try` **之外**声明（`dsh-manager.js:1098-1100`），catch（`:1359-1362`）可访问 ✔。
- 逐符号核对 catch 体（`:1359-1385`）实际引用的标识符：`stagingDir`、`tmpPrefix`、`err`、`coreMutated`、`previousVersion`、`this.lastExitInfo`、`log`、`emitProgress` —— 全部在函数作用域可见 ✔。
- `sourceDir`（`:1170`，`try` 内声明）**未在 catch 中出现**（`grep -n sourceDir` 仅 `1170/1172/1232/1233/1240/1257`，全在 `try` 内）✔；`prevArchive`/`targetArchive` 同理 ✔。
- 回滚内层 catch（`:1483`）只引用 `rbErr`/`log`/`this.installing` ✔。
- `[J]` 回归测试（`scripts/version-store-test.mjs:161-174`）确实**注入了真实早期失败**（monkeypatch `_assertDiskSpace` 抛「磁盘空间不足」）并断言返回错误对象而非 ReferenceError、`untouched:true`、日志含真实原因 ✔——是有效回归，不是形式测试。

## B. `moveDirOrCopy` 的 EXDEV 退化是否等价安全 —— **PASS（不会同时丢 live 与 backup）／非原子**

`moveDirOrCopy`（`:187-198`）：`renameSync` 失败且 `code==='EXDEV'` → `mkdirSync(dst)` + `cp -a src/. dst/` + `rm -rf src`；非 EXDEV 直接抛 ✔。

- **顺序是「先复制后删除」**：`src` 只在 `cp` 成功之后才被 `rm`；`cp` 失败 → 抛错、`src` 完好 ✔。因此**不存在「复制失败已把 live 删掉」**的组合。
- `_atomicSwapCore` 第一次 `moveDirOrCopy(LIVE_CORE_DIR, backupDir)`（`:1513`）若在 `cp` 阶段失败 → 抛「无法暂存原核心，现网未受影响」（`:1514-1516`）——**该描述属实**（live 未动）✔。
- **非原子**（与 rename 不等价）：`rm -rf src` 之后、`renameSync(staging, LIVE_CORE_DIR)`（`:1520`）之前存在「无 live 目录」的窗口（此时 DSH 已 `stop()`）；若此时进程被杀，靠 `entrypoint.sh` 1.15.1 自愈。
- **`restoreCoreFromBackup` 的隐患**（`:201-205`）：它**先 `rmSync(LIVE_CORE_DIR)`**，再 `moveDirOrCopy(backupDir, LIVE_CORE_DIR)`。若这次 move 在 `cp` 阶段失败，live 已被删、只剩部分拷贝 → 可能留下「无/半份 live」。但**backup 只在复制成功后才被删**，所以**绝不会同时丢 live 与 backup**；且 live 缺失时可被 entrypoint 自愈（backup 仍在 `.dsh-rollback-*`）✔。失败仅 `console.error`（`:1525`），不冒泡到 API 结果——建议提升为可见告警。

## C. `coreMutated` 语义漏洞 —— **PASS（无误跳过回滚的路径）**

- `coreMutated = true` 在 `:1268` 设置，位置是 `await this.stop()`（`:1269`）与 `_atomicSwapCore`（`:1270`）**之前**。
- 逐路径核对「会改动 live 核心」的动作：核心置换 `:1270`、阶段 4 补丁 `:1277-1286`、阶段 5 重启 `:1296`、回滚里的置换/`npm install -g`（`:1404`/`:1417`）——**全部发生在 `coreMutated=true` 之后**。此前只有只读操作（阶段 2 从 live `cp -a` 归档 `:1153`、磁盘预检 `:1251`、staging 复制 `:1257`）✔。
- 因此**不存在「已改动核心但 coreMutated 仍为 false」**的路径；错误方向是安全的（最多多做一次不必要的回滚，绝不会漏回滚）✔。早退分支（`:1377-1383`）返回 `untouched:true` 并复位 `installing` ✔。
- 唯一轻微：`coreMutated` 设得**略早**（在 `stop()` 前）。若 `stop()` 本身抛错（live 其实没被改），会触发一次多余回滚；若上一版未归档，该回滚会走 npm 重下。概率极低，方向安全，可接受。

## D. `_assertDiskSpace` 阈值/边界/降级 —— **PASS（2 点注意）**

- 单位与解析：`MIN_FREE_BYTES = Math.max(64, Number(process.env.DSH_VERSIONS_MIN_FREE_MB) || 1536) * 1024 * 1024`（`:152`）。`NaN`/空串/`0` → 回落 1536；负数 → 夹到 64MB；MB→字节换算正确 ✔。`free = st.bavail * st.bsize`（`:1543`）单位正确 ✔（Node v24 `statfsSync` 可用，本机已验证）。
- 调用点 `:1251` 在 `stop()`/置换之前 → **不足时不触碰现网核心**，符合 Lead 描述 ✔。
- 注意 1（fail-open）：`statfsSync` 抛错（如路径不存在）时走 `catch`，除「磁盘空间不足」外一律 `log('跳过磁盘水位检查')` 并**继续**（`:1548-1551`）。即预检可被静默绕过（判据用中文字符串正则匹配，较脆弱）。
- 注意 2：预检在**下载之后**（阶段 3 的 `npm install` 在 `:1192`，预检在 `:1251`），因此**不保护下载阶段的磁盘消耗**；它保护的是 staging 复制 + 置换。可接受，但与「切换前预检」的措辞略有落差。

## E. 静默失败 / 资源泄漏 —— **PASS（上轮泄漏已修）／1 处残留**

- **`tmpPrefix` 泄漏已修复**：npm 失败删（`:1219`）、staging 就绪后删并置空（`:1264`）、catch 兜底删（`:1362`）✔。上轮报告的「成功路径永不删 `tmpPrefix`」已消除。
- 残留（轻微）：**下载后归档的 catch 不删 `archTmp`**（`:1244-1246`，对比阶段 2 `:1158`、阶段 5 `:1328` 都删了）→ 失败时在持久卷 `.staging/` 留半份目录，直到 `cleanupStagingOrphans`（>1h）。
- 残留（轻微）：`moveDirOrCopy` 在 EXDEV 的 `cp` 阶段失败时，会留下部分 `.dsh-rollback-*`（`:193` 已 mkdir）无清理；靠 entrypoint >60min 清理。
- 其余 best-effort 静默点（`_touchVersionUsage`、`rmSync(backupDir)`、`_assertDiskSpace` 跳过）均为设计取舍，非缺陷。
- 并发：`gcVersions`（`:1594`）与 `deleteCachedVersion`（`:1641`）均 `if (this.installing) return {...}` 拒绝并发 ✔（上轮意见已采纳）。

## F. 文档一致性 —— **PASS**

- `CHANGELOG.md:7-19` 新增 `[Unreleased]` 条目，覆盖持久化卷/原子置换/overlayfs EXDEV/`.ready`/静默失败/治理 API/自愈/文案 ✔。
- `README.md` 4 处挂载清单（`docker run` 两处 + compose 两处，`:73/:89/:122/:142`）均补 `./data/versions:/root/.dsh-versions` ✔。
- `Dockerfile:365` VOLUME、两份 compose、`scripts/entrypoint.sh:21-22`（`DSH_VERSIONS_DIR`）三处一致 ✔。
- `scripts/dsh-version-validation-test.mjs:52-54` 基准路径已改为 `/root/.dsh-versions` ✔。
- 全仓库（除 `doc/` 与 CHANGELOG 的历史性描述）**已无 `/app/.dsh-versions-cache` 残留** ✔。

## 终版总评

A/B/C/D/E/F **六项全部 PASS**（B/D/E 各带 1–2 处轻微注意项，均不阻断）。上轮我提出的 6 条意见中：`tmpPrefix` 泄漏、`ln` 触发回滚、磁盘预检缺失、GC/DELETE 并发、陈旧测试路径、CHANGELOG 缺失——**已全部修复或采纳**；`.ready` 的 `fileCount`/`sizeBytes` 也已补上。当前实现的核心语义（staging 复制 → 置换、`.ready` 门禁、`coreMutated` 早退、LRU 保护活动/出厂版、防穿越）经静态审计与单测（39+34）自洽。

合并前可选的小修（非阻断）：
1. 下载后归档 catch 补 `rmSync(archTmp)`（对齐阶段 2/5）。
2. `restoreCoreFromBackup` 失败时把错误写入 installLog/返回体，而非仅 `console.error`。
3. `_assertDiskSpace` 的 fail-open 改为可配置的 fail-closed，或至少把「跳过」升级为醒目告警。

### 本轮无法确认的事项

1. **EXDEV 退化路径的真实触发**——`overlayfs 无法 rename lower 层目录` 与代码注释一致，也符合内核文档（无 `redirect_dir` 时返回 EXDEV），但我**无法在本容器复现**：需要真的对 `/usr/local/lib/node_modules/@deepseek-ai/dsh`（镜像 lower 层）做 rename，超出我的写权限。故该机制**UNVERIFIED（可信但未自测）**；退化分支本身未被单测覆盖（`grep` 确认测试未引用 `moveDirOrCopy`/`_atomicSwapCore`）。
2. **端到端 21/0 远程结果**——我无法复核远程环境；本地只能验证到静态读码 + 39/34 单测。
3. **磁盘满、容器强杀、回滚失败的真实行为**——同上，需真实容器操作。

---

# 复核手动归档与回滚点延迟清理（第三轮）

- 方法：重读当前工作树（不沿用前两轮结论）+ 实跑 `node scripts/version-store-test.mjs`（**53/53 PASS**，含新增 `[K]` 静态作用域守卫与 `[L]` 置换/回滚点生命周期）。
- **本轮先发现一处未被 Lead 点名的重大变更**：版本库默认路径从 `/root/.dsh-versions` 改为 **`$DSH_SNAPSHOTS_DIR/versions`（默认 `/root/.dsh-snapshots/versions`）**（`dsh-manager.js:147`、`entrypoint.sh:22`），Dockerfile VOLUME 回到 4 项（`Dockerfile:365`，无 `/root/.dsh-versions`），compose 也删掉了 `./data/versions` 挂载（改为复用 `./data/snapshots`）。已核验其与 `backup-service.js` 的相互影响**安全**（见 F）。

## A. 回滚语义（回滚点延迟清理）—— **PASS（主路径扎实）／3 处轻微缺口**

- **主路径**：`rollbackDir = _atomicSwapCore(staging)`（`:1275`）→ 阶段 4/5 → 探活通过才 `_disposeRollbackDir`（`:1323-1327`）。探活失败进 catch，**首选** `rollbackDir && fs.existsSync(rollbackDir)` → `_restoreFromRollbackDir`（`:1393-1399`，本地秒级、不联网、不依赖归档）✔；归档分支（`:1402-1414`）与 npm 分支（`:1415-1428`）仅在无回滚点时兜底 ✔。
- **「已消费 + 后续再失败」**：`_restoreFromRollbackDir` 成功后 `rollbackDir=null`（`:1398`）；若随后插件复位（`:1439-1444`）或重启探活（`:1455-1465`）失败 → 进 `catch (rbErr)`（`:1489`），此时 `rollbackDir` 为 null，兜底条件（`:1492`）**不成立**，直接返回 `{ok:false, error:'切换失败且回滚异常'}`。**结论：不会退化到 npm，也不会丢核心**（核心已在第一步还原为旧版），但**服务可能停在未就绪状态**、错误信息不透明，需人工重启 DSH。属 UX 缺口，非正确性缺陷。
- **真正的兜底**：若 `_restoreFromRollbackDir` 自己抛错（rollbackDir 未被置 null）→ `catch(rbErr)` 的 `:1492` 条件成立（回滚点仍在且 live 核心缺失）→ 二次还原 ✔；再失败则保留回滚点交 entrypoint 自愈（`:1498`）✔。
- **`coreMutated=true` 但 `rollbackDir=null` 的三条路径**（Lead 追问点）：
  1. `_atomicSwapCore` 返回 null 当 `LIVE_CORE_DIR` 原本不存在（`:1526` `moved=false`）——没有旧核心可保留，落归档/npm 合理（容器已损坏的边界）。
  2. `moveDirOrCopy` 暂存旧核心失败（`:1530`）→ 抛错、`rollbackDir` 未赋值。**rename 失败时 live 未动**（安全）；但 **EXDEV 分支的 `cp` 成功、`rm -rf` 失败/半删时**，live 可能被部分破坏而 `rollbackDir=null` → 回滚退化到归档/npm（仍可恢复旧版，最坏重新下载）。**这是唯一「核心已部分改动且无回滚点」的真实窗口，概率极低**。
  3. `renameSync(staging→live)` 失败但 `restoreCoreFromBackup` 已成功（`:1540`）→ live 已是旧核心，`rollbackDir=null` → catch 仍会走归档/npm 分支，**对已正确的核心做一次冗余还原**（无归档时会白下载一次）。方向安全，属浪费。

## B. EXDEV 退化分支下回滚点是否完整 —— **PASS**

`moveDirOrCopy`（`:187-198`）EXDEV 时执行 `mkdirSync(dst)` + `cp -a src/. dst/` + `rm -rf src`。回滚点是 **`cp -a` 的完整物理拷贝**（不是软链/硬链），`_restoreFromRollbackDir` 可完整还原 ✔。且 `moved=true` 只在 `cp`+`rm` **都成功**后置位（`:1529-1533`），因此 `cp` 失败时 live 原封不动、错误信息「现网未受影响」属实 ✔。轻微：EXDEV 的 `cp` 阶段失败会遗留半个 `.dsh-rollback-*`（`:193` 已 mkdir），靠 entrypoint >60min 清理。

## C. 是否还有隐式自动归档残留 —— **PASS**

全仓库 `grep writeReadyMarker`：**唯一调用点 `dsh-manager.js:1167`（阶段 2，受 `archiveCurrent` 门禁）** ✔。「下载即归档」（原 `archive-new-*`）与「切换成功即归档」（原 `archive-final-*`）已删除，代码中仅剩注释说明（`:1250-1251`、`:1328`）✔。`grep archiveCurrent` 仅 4 处（admin.html:3845、index.js:622/633、dsh-manager.js:1105）✔。

## D. `archiveCurrent` 参数校验 —— **PASS（fail-closed）**

`index.js:622` `body.archiveCurrent === true`，`dsh-manager.js:1105` `options && options.archiveCurrent === true` —— **两层都严格 `=== true`**。字符串 `"true"`、`1`、`{}`、缺省一律为 false → 不归档。安全方向正确（不会因怪值意外占用 477MB）。注意：后端「缺省=不归档」与 UI「默认勾选」不一致，但 UI 总是显式发送布尔值（`admin.html:3845`），故无实际影响；非 UI 调用方缺省即不归档，属保守合理。

## E. 弹窗勾选读取时机与语义 —— **PASS**

- **读取时机正确**：`executeInstallConfirmed()` 先读两个 checkbox（`:3801-3804`），**再** `closeSwitchConfirmModal()`（`:3805`）✔（若顺序颠倒会读不到）。
- **默认值语义一致**：打开弹窗时 `archEl.checked = true`（默认勾选）且 `archEl.disabled = alreadyArchived`（`:3672-3676`）；`snapEl.checked = false`（配置快照需显式勾选）。默认勾选 → `archiveEngine=true` → 后端归档**被离开的版本**（阶段 2 用 `previousVersion`）✔，与文案「归档当前引擎 v<当前版本>」一致 ✔。
- 版本已在库中时 `disabled` 但 `checked` 仍为 true → 后端 `isReadyVersionDir(prevArchive)` 命中直接复用（`:1153`），不会重复拷贝 ✔。
- 文案与后端语义对齐：`:2320-2326` 明确「安全回滚与勾选无关」，与 A 的结论一致 ✔。

## F. `[L]` 测试是否覆盖生产路径 + 文档一致性 —— **PARTIAL（无假阳性，但仅 helper 级）／F 轻微 FAIL**

- `[L]`（`version-store-test.mjs:203-236`）**直接调用** `_atomicSwapCore` / `_restoreFromRollbackDir` / `_disposeRollbackDir`，在 `DSH_TEST_CORE_PARENT` 隔离的临时目录上断言：返回回滚点、探活前不删、live 切到新版、回滚点保留旧版、还原后回到旧版且回滚点被消费、dispose 后 live 仍新版 —— **断言真实、无假阳性** ✔。
- **但未覆盖生产编排**：它不经过 `installVersion` 的 catch 分支（`rollbackDir && exists` → 首选还原 → 后续步骤失败 → `catch(rbErr)` 兜底），也不覆盖 **EXDEV 分支**（临时目录同文件系统 → `moveDirOrCopy` 走 rename，`cp+rm` 退化路径零覆盖）。故「生产路径」覆盖度**不足**，属 PARTIAL。新增的 `[K]` 是静态作用域守卫（正则解析 installVersion 的 try 边界），思路不错。
- **安全**：测试在 `require` 之前设置 `DSH_TEST_CORE_PARENT`（`:27-29`），不会误伤真实 `/usr/local/lib/node_modules` ✔。
- **新存储位置的互操作已核验安全**：`SNAPSHOTS_DIR/versions` 与配置快照同卷，但 `backup-service.js` 只处理 `*.tar.gz`（`listBackups` `:595` 过滤、`getBackupPath` `:641-648` 用 `path.basename` + 强制 `.tar.gz`），不会读到/删到 `versions/` 子目录 ✔；快照打包仍是 `tar -C /root .dsh`（`:236`），不含 `.dsh-snapshots` ✔。
- **轻微不一致（FAIL-minor）**：
  1. `scripts/dsh-version-validation-test.mjs:52-54` 基准路径仍是 **`/root/.dsh-versions`**，而新默认是 `/root/.dsh-snapshots/versions`（纯函数测试，无功能影响，但属上一轮遗留）。
  2. `dsh-manager.js:141` 注释仍写「迁移到持久化卷 `$DSH_HOME/.dsh-versions`」，与 `:147` 的实际默认（`SNAPSHOTS_DIR/versions`）矛盾。
  3. `README.md` 已回退到 HEAD（无 `data/versions`，与当前设计不冲突），但**未说明版本库落在快照卷内** —— 用户可见文档缺口。
  4. `doc/issue-7/verification.md`、`design-gemini.md` 中的 `/root/.dsh-versions` 均为历史记录，无需改。

## 总评

A/B/C/D/E **五项 PASS**（A 有 3 处轻微缺口，均不导致核心丢失或静默错误），F 为 **PARTIAL/轻微 FAIL**。核心设计（用户可选归档 + 回滚点延迟清理 + 探活前保留）自洽：**回滚不再依赖归档、不联网**，与「不勾选归档」的语义解耦正确；「归档被离开的版本」与 UI 默认勾选一致。53/53 单测通过。

建议（非阻断）：
1. `catch(rbErr)` 在「回滚点已消费且 live 已是旧核心」时，至少尝试 `restart` 一次并给出可读提示，避免服务停在未就绪态。
2. 让 `[L]` 增加对 `installVersion` catch 编排与 EXDEV 退化的覆盖（可用 monkeypatch 强制 `renameSync` 抛 `EXDEV`）。
3. 清理 `:141` 陈旧注释与 `dsh-version-validation-test.mjs:52` 的旧基准路径。

### 本轮无法确认的事项

1. **EXDEV 真实触发** —— 仍需对镜像 lower 层目录做 rename，超出我的写权限；退化分支依旧零测试覆盖（**UNVERIFIED**）。
2. **远程 26/0 与 53/53 之外的端到端行为**（真实探活失败后的回滚点还原、`restart` 再失败的服务状态）—— 无法在本容器触发。
3. **`_assertDiskSpace` 在新 store 位置（快照卷）上的真实水位行为** —— 静态正确，未实测卷满。
