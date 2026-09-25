# 对抗式代码审阅报告 — 后端网关改动（Gemini 交付物）

- 审阅者：子代理 1（newapi/deepseek-v4.1-flash），独立于实现者
- 被审文件：`gateway/version-service.js`、`gateway/dsh-manager.js`、`gateway/index.js`（含相关 `admin.html` / `scripts/entrypoint.sh` 契约面）
- 方法：逐行静态审阅 + 可执行探针（node 实跑复现）+ 现有单测回归
- 工作树：`/workspace/deepseek-harness-docker`，Node v24.21.0
- 结论：**1 个确定性功能缺陷（自动 GC 永不执行）+ 1 个跨镜像误复用风险 + 若干边界/契约隐患**；无循环依赖；单测全绿但存在覆盖盲区。

---

## 一、复现证据（可执行探针）

| 编号 | 探针 | 结果 |
|---|---|---|
| E1 | `mgr.installing = true` 后 `mgr.gcVersions({keepN:3})` | `{"ok":false,"error":"版本切换进行中，已拒绝并发清理"}`；随后 `gc.removed.length` → `TypeError: Cannot read properties of undefined (reading 'length')` |
| E2 | 并发两次 `fetchRemoteMeta(true)` | 实际网络请求 **1 次**，两次返回**同一对象** → `inFlightFetch` 聚合有效 |
| E3 | 先 remote 成功，再用离线 stub 触发第二次 fetch，然后 `isUsingRemoteMeta()` | 调用方仍持有 `latest=9.9.9`(remote) 的 meta，但全局标志已变 `false` → **来源标志与所用 meta 不一致** |
| E4 | `'rc.10'.localeCompare('rc.9')` | `-1` → 按 semver 规范 `rc.10 > rc.9`，`compareSemver` 排序错误 |
| E5 | 现有单测回归 | `dsh-version-validation-test` 34/0；`version-store-test` 57/0；`version-matrix-sync-test` 28/0（均通过） |
| E6 | `measureDir('/usr/local/lib/node_modules/@deepseek-ai/dsh')` | 25517 文件 / 477MB，**同步耗时 112ms**（热缓存） |

---

## 二、Critical 致命风险

### C1. 自动版本库 GC 永远不会执行 —— 版本库无界增长（确定性缺陷）

**证据链**
- 成功路径调用点：`gateway/dsh-manager.js:1345` `const gc = this.gcVersions({ keepN: GC_KEEP_DEFAULT, activeVersion: currentVer });`，紧跟 `if (gc.removed.length) log(...)`。
- 但 `this.installing = false;` 在 `gateway/dsh-manager.js:1365`，**在 GC 调用之后**。
- `gcVersions` 首行守卫：`gateway/dsh-manager.js:1664` `if (this.installing) return { ok: false, error: '版本切换进行中，已拒绝并发清理' };` —— 该返回**不含 `removed`**。
- 因此 `gc.removed.length` 抛 `TypeError`，被外层 `try { ... } catch (e) { log('⚠️ 版本库 GC 跳过: ' + e.message) }`（1346-1348）吞掉。
- 探针 E1 已实跑复现。

**影响**：`GC_KEEP_DEFAULT=3` 的 LRU 治理、`.staging`/`.dsh-rollback-*` 过期残留清理（`cleanupStagingOrphans` 仅由 `gcVersions` 调用）**全部失效**。持久化版本库（快照卷）会随每次用户勾选归档而无界增长（单份 ≈477MB），最终撑爆快照卷；这与 Issue #7 想解决的"磁盘只增不减"目标直接冲突。

**修复建议（二选一或同时）**
```js
// 方案 A（最小改动）：成功路径先复位安装标志，再 GC
this.installing = false;
this.lastKnownVersion = '';
try {
  const gc = this.gcVersions({ keepN: GC_KEEP_DEFAULT, activeVersion: currentVer });
  if (gc.ok && Array.isArray(gc.removed) && gc.removed.length) {
    log(`🧹 版本库 GC：已清理 ${gc.removed.length} 个旧版本，释放 ${formatBytes(gc.freedBytes)}`);
  }
} catch (e) { log(`⚠️ 版本库 GC 跳过: ${e.message}`); }
```
```js
// 方案 B（更稳）：给内部调用一个显式豁免，调用方也做判空
gcVersions({ keepN = GC_KEEP_DEFAULT, dryRun = false, activeVersion = null, internal = false } = {}) {
  if (this.installing && !internal) return { ok: false, error: '版本切换进行中，已拒绝并发清理' };
  ...
}
// 调用点：this.gcVersions({ keepN: GC_KEEP_DEFAULT, activeVersion: currentVer, internal: true })
```

### C2. 版本库跨镜像按"版本号"复用，`imageRevision` 只记录不校验 —— 跨镜像误部署陈旧核心

**证据链**
- `isReadyVersionDir`（`gateway/dsh-manager.js:240-247`）只校验 `.ready` 存在 + `nodeAbi` + `arch` + 非空 `node_modules`，**从不比对 `marker.imageRevision`**。
- `writeReadyMarker` 确实写入了 `imageRevision: IMAGE_REVISION`（`:263`），`getVersionsStoreStats` 也把它回传（诊断用），但没有任何**准入校验**。
- `IMAGE_REVISION`（`:163-167`）由 `version.json.latest.version + supply.dshVersion` 拼成——而 `doc/issue-7/verification.md` 已指出：**镜像更新经常不改这两个值**（"Gemini §5 risk-1 近乎空转"）。
- 版本库落在持久化快照卷（`$DSH_SNAPSHOTS_DIR/versions`），**天然跨容器世代存活**。

**影响场景**：用户 `docker compose pull && up -d` 升到新镜像（新镜像内置的核心 0.1.7-rc.1 可能含新补丁/新基座）后，切回 0.1.7-rc.1 时命中旧镜像归档的**同名目录**，直接部署**旧镜像的核心树**；`FALLBACK_DSH_VERSION`/GC 的"出厂基准版本保护"又按名字保护它，永不清理。verification.md 已把"key 需加入镜像 revision 或内容摘要"列为落地前必须补齐的洞 #1，本次实现**未落地**。（缓解项：切换后会重跑 `install-plugin.mjs` / `patch-dsh-client.mjs`，补丁层会被刷新，但**核心基础文件仍来自旧镜像**，故仍属正确性缺陷。）

**修复建议**
```js
// 1) 让 IMAGE_REVISION 真正随镜像内容变化：加入核心内容摘要（构建期写入 version.json 更佳）
const IMAGE_REVISION = (() => {
  const p = VERSION_META?.latest?.version || 'unknown';
  const d = VERSION_META?.supply?.dshVersion || 'unknown';
  const c = VERSION_META?.supply?.coreDigest || 'nogit'; // 构建期写入 lib/bin.js+package.json 摘要
  return `proj${p}-dsh${d}-${c}`;
})();

// 2) 复用时严格校验来源镜像；不匹配则视为不可用（触发重新下载/归档）
function isReadyVersionDir(dir, { strictImage = true } = {}) {
  ...
  if (strictImage && marker.imageRevision && marker.imageRevision !== IMAGE_REVISION) return false;
  ...
}
// 或按镜像命名空间隔离：VERSIONS_DIR/<imageRevision>/<version>
```

---

## 三、Warning 边界隐患

### W1. `isUsingRemoteMeta()` 是全局标志，与调用方持有的 `meta` 存在请求级竞态
`gateway/version-service.js:55-57` 读全局 `this._isRemoteMeta`；`gateway/index.js:558-566` 先用请求开头的 `meta` 算 `versionEvaluations`，再在**两次 await 之后**读 `isUsingRemoteMeta()`。期间另一请求若把缓存刷成离线兜底，就会 `evaluations 来自 remote` 而 `isRemoteMeta=false`（探针 E3 复现，反向亦然）。
**修复（请求级、最小侵入）**：给 meta 打非枚举标记，按对象判定。
```js
// version-service.fetchRemoteMeta 成功分支：
Object.defineProperty(data, '__remote', { value: true, enumerable: false });
// 失败分支：Object.defineProperty(local, '__remote', { value: false, enumerable: false });
// index.js: data.isRemoteMeta = Boolean(meta && meta.__remote);
```

### W2. `/api/version/check` 未返回 `isRemoteMeta`，与前端探测契约不符（假阴性）
前端 `resolveRemoteCompatFlag`（`admin.html:2898-2906`）会探测 `versionCheckData.isRemoteMeta`，但 `versionService.check()` 的返回体（`version-service.js:346-383`）**根本没有该字段**；于是徽章只能依赖 `availableIsRemoteMeta`（仅由 `loadVersions` 写入），在 `loadVersions` 之前渲染时恒为「📦 本地离线规则」，即使云端已同步。
**修复**：`check()` 返回体加入 `isRemoteMeta: this.isUsingRemoteMeta()`（并按 W1 改为请求级判定）。

### W3. `compareSemver` 预发布段用 `localeCompare` —— 多位数预发布排序错误
`version-service.js:28` / `dsh-manager.js:137`：`p1.pre.localeCompare(p2.pre)`。探针 E4：`'rc.10'.localeCompare('rc.9') === -1`，即 `rc.10 < rc.9`，违反 semver。影响面：`fetchAvailableVersions` 的 `sort(compareSemver)` 选 `latest`、CDN 陈旧守卫 `compareSemver(data.latest.version, local...) < 0`、`isUpToDate`/`hasUpdate` 判定。当前版本号恰好是个位数（rc.1/rc.2）所以没暴露，属**潜伏 bug**。
**修复**：按 semver 规范分段比较（数字段数值比较、字母段 ASCII 比较）。
```js
function cmpPre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;  if (!b) return -1;
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d < 0 ? -1 : 1; }
    else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
```

### W4. 规则"首个命中即返回"，数组顺序却是低危→高危，与注释矛盾
`version-service.js:245` `for (const rule of rules)` 按数组顺序返回第一个命中；而注释写"从高危到低危"，实际数组是 `<0.1.5-rc.1`(warning) → `<0.1.7-alpha.1`(warning) → `>=0.2.0`(danger)。当前三条规则互不重叠所以没事，但**规则现已来自远端 version.json**，一旦新增重叠规则，`danger` 可能被 `warning` 抢先命中 → `check()` 的 `overallLevel` 与前端红牌卡降级为黄牌，属**安全语义降级**。
**修复**：按 severity 排序后匹配。
```js
const RANK = { danger: 3, warning: 2, info: 1, success: 0 };
for (const rule of [...rules].sort((a, b) => (RANK[b.level] || 0) - (RANK[a.level] || 0))) { ... }
```

### W5. `recommendedDsh` 未随 rc.2 适配同步（静态占位与动态数据不一致）
本次 diff 更新了 `supportedDshRange` 与 `adaptedVersions`（version.json / version-service 兜底 / dsh-manager DEFAULT），但 `recommendedDsh` **仍是 `0.1.7-rc.1`**（`version.json:172`、`version-service.js:126`），而 `admin.html` 静态占位文本已改成 `v0.1.7-rc.2`。结果："推荐核心"动态渲染为 rc.1、静态 HTML 为 rc.2；`version-matrix-sync-test` 因 rc.1 仍在 adapted 列表而"假绿"。
**建议**：明确语义——若推荐仍是 rc.1 则回滚 admin.html 静态占位；若推荐升级为 rc.2，则同步 `version.json.recommendedDsh`、`version-service.js` 兜底、`admin.html` 四处（该测试会强制）。

### W6. 同步阻塞事件循环：`cp -a` 大拷贝与 `measureDir` 全树 stat
- `runSyncSafe('cp', ...)`（归档拷贝 `:1176`、staging 拷贝 `:1276`、回滚拷贝 `:1426`）是 **`spawnSync`**，477MB/25.5k 文件、实测热缓存 ≈1.4–1.6s（冷盘更久），期间**整个网关（反代 + SSE 进度流）被阻塞**；而同一流程的 npm 下载却用异步 `spawn`，风格不一致。
- `listStoreEntries`（`:180`）对每个版本调 `dirSizeBytes`→`measureDir` 全树 `statSync`（实测 112ms/份，3 份 ≈300ms+），且**明明 `.ready` 里已存 `sizeBytes` 却每次重算**；`/api/dsh/versions/stats`、`/api/dsh/versions/gc` 会同步阻塞。
**建议**：拷贝改用异步 `spawn`（复用 `npm install` 的写法）；`listStoreEntries` 优先读 `marker.sizeBytes`，仅在缺失时回退遍历；stats 结果做短 TTL 缓存。

### W7. `/api/dsh/versions` 串行等待两段网络，冷缓存/refresh 最坏 ~22s
`index.js:558` 先 `await fetchRemoteMeta(force)`（4 通道 × 4s 超时 = 16s 最坏），再 `await fetchAvailableVersions`（registry 6s 超时 + npm 兜底），前端 `loadVersions`（`admin.html:3561`）无超时。首屏或 `refresh=1` 时接口可能长时间挂起。
**建议**：两段并行（`Promise.all`），或先用缓存 meta 立即返回、异步刷新后再推送；至少给前端加超时与"规则同步中"占位。

### W8. 离线兜底会"锁死"10 分钟且 `_isRemoteMeta` 语义含糊
全通道失败时 `cachedMeta = local; lastFetched = Date.now(); _isRemoteMeta = false`（`:216-218`）→ 之后 10 分钟 `force=false` 一律直接返回本地，不再重试（网络恢复也不重试）。这是 TTL 设计使然，但运维上需知晓；且 `_isRemoteMeta` 只描述"最后一次完成的 fetch"，不代表"当前 UI 展示的规则一定来自本地"。

### W9. `_atomicSwapCore` 的"原子置换"存在 live 缺失窗口；自愈脚本取"最新"回滚点不严谨
两步 `renameSync`（`LIVE→backup`，`staging→LIVE`）之间存在毫秒级"活动核心不存在"窗口，并非真正原子（注释"原子置换"略有夸大）。进程若在该窗口崩溃，只能靠 `scripts/entrypoint.sh:96` 自愈，而 `ls -1d ... | sort | tail -1` 按 `pid-ts` 字符串排序**不保证取到最新**回滚点。
**建议**：自愈改为按 mtime 取最新（`ls -1dt ... | head -1`）；注释如实说明窗口与依赖 entrypoint 自愈。

### W10. 并发保护与 C1 同源耦合；调用方缺防御性判空
`gcVersions`/`deleteCachedVersion` 用 `this.installing` 做互斥，而 `installVersion` 自身也用它做"安装中"标志 → 任何"安装内部调用治理方法"的写法都会自锁（C1）。此外 `gc.removed` 未判空即 `.length`（1346）是脆弱写法。
**建议**：拆成两个标志（`installing` vs `maintenanceBusy`），或引入 `internal` 豁免（见 C1 方案 B）。

### W11. `IMAGE_REVISION` 检测不到多数镜像更新（与 C2 同源）
即便补上 C2 的校验，`IMAGE_REVISION` 仍依赖 `latest.version + supply.dshVersion`，而镜像更新常不改这两值 → 校验形同虚设。需引入真正的镜像指纹（构建期注入 `supply.coreDigest`/`GIT_SHA`）。

### W12. 旧归档无迁移、无识别
`getCachedVersions()` 现要求 `.ready`（`:557`），旧 `/app/.dsh-versions-cache/*`（无 marker）既不会被迁移也不会被识别；升级后首次回切必重新下载。设计上已接受，但建议在日志/UI 明示一次"历史快照已失效"，避免用户以为丢数据。

---

## 四、Suggestion 优化建议

- **S1（覆盖盲区）**：`version-matrix-sync-test.mjs` 的正则 `adaptedVersions:\s*\[` 只能匹配 `getLocalMeta` 的清单，**匹配不到 `evaluateTargetVersion` 内联兜底 `m.compatibility?.adaptedVersions || [...]`**（`version-service.js:230-240`）。这处第四份硬编码清单不受测试保护，存在漂移风险。建议抽成单一模块常量并统一断言。
- **S2（阈值偏严）**：`_assertDiskSpace` 默认 `MIN_FREE_BYTES=1536MB`（`:159`）对"目标已缓存、仅需 staging 拷贝（峰值 ≈2×477MB）"的场景偏严，低配宿主会被误拒；且对版本库卷与容器层都要求 1.5GB。建议按"需下载 / 仅置换"区分阈值，并在文档化 `DSH_VERSIONS_MIN_FREE_MB`。
- **S3（错误识别脆弱）**：`_assertDiskSpace` 用 `/磁盘空间不足/` 正则区分"自己抛的错"与 `statfs` 错误（`:1616`），文案一改即失效；建议自定义 `Error` + `code='ENOSPC_GUARD'`。
- **S4（回滚原语仍"先删后拷"）**：`restoreCoreFromBackup`（`:208-212`）先 `rmSync(LIVE_CORE_DIR)` 再搬运备份；虽备份在手，但若搬运失败会同时失去新旧核心。建议先把备份复制/重命名到临时名，再原子替换。
- **S5（CDN 守卫不完整）**：陈旧守卫只比较 `latest.version`，且两个 jsDelivr 通道无 cache-buster（`:177-178`）。当 CDN 与本地同版但真实远端更新时，守卫放行 → 漏更新。建议全通道加时间戳参数，或维护"历史最高版本"单调基准。
- **S6（判定不一致）**：`check()` 的 `dsh.hasUpdate`（`:364`）用**未校验**的 `compareSemver(latestDshVer, currentDshVer)`，而上面的 `hasDshUpdate`（`:300`）有 `isSemver` 守卫 → 可能出现 `level:'success'` 却 `hasUpdate:true`。建议统一走 `isSemver`。
- **S7（小瑕疵）**：`this.lastGcAt` 只写不读（死字段）；`/api/dsh/versions/gc` 的 `Number(body.keepN) || undefined` 会吞掉 `keepN=0`（无法请求"只留受保护版本"）。建议 `Number.isFinite` 判断。
- **S8（早停）**：`coreMutated = true` 在 `await this.stop()` **之前**设置（`:1286`）；若 `stop()` 抛错，会走"熔断回滚"而无谓地重装/置换。建议 stop 成功后再置位，或按错误类型分支。
- **S9（接口面）**：新增 `/api/dsh/versions/stats|gc|:version` 目前**无任何前端消费**（console-plan 尚未实现），DELETE 响应还回传内部绝对 `dir`。建议收敛响应字段，或补齐前端。
- **S10（未来约束，务必记入计划）**：`cleanupStagingOrphans` 的正则 `/^\.dsh-(staging|rollback)-/`（`:1699`）与 `entrypoint.sh:105` 的 `-name ".dsh-rollback-*"` 会命中计划中的 `.dsh-rollback-preserved`。`doc/issue-7/console-plan.md` 已明确指出"只改名不够"，若不显式排除，"手动保留回滚点"最多活 60 分钟。这是本轮改动给下一版功能埋下的**隐性阻塞**。

---

## 五、Positive 亮点

- **P1 消除破坏性删除窗口**：`_atomicSwapCore` 走"staging 复制 → 目录置换"，取代旧的 `rm -rf` 活动核心再 `cp -a`；EXDEV 降级为复制+删除；回滚点保留到探活通过才清理。测试 `[L]` 全绿，含 EXDEV 注入与"还原后消费回滚点"。
- **P2 完整性判据升级**：`.ready` 签名（`nodeAbi`/`arch`/非空 `node_modules`）取代"仅看 `package.json`"，半成品归档不再被当作可用缓存（测试 A/B/C 覆盖）；归档写入 marker 后才 `renameSync` 入位，顺序正确。
- **P3 静默失败被消除**：`runSyncSafe` 让裸 `spawnSync` 的返回码/异常显式化；回滚 npm 分支补上 `rbExit !== 0` 校验，修掉旧代码"cp 失败仍打印成功"的隐患。
- **P4 失败分层合理**：`coreMutated` 使"未触碰现网"的失败直接返回 `untouched:true` 且不停服，避免预检失败却触发熔断回滚。
- **P5 并发聚合有效**：`inFlightFetch` 实测并发两次 force 仅 1 次网络请求并返回同一对象；`force` 的 purge 副作用有 `.catch(()=>{})` 兜底，不会因 CDN 不可达而污染主流程。
- **P6 安全纵深**：`resolveWithinDir` + `isValidVersion` 双重把关；DELETE 路由 `decodeURIComponent` 后仍拒绝 `/`；`.staging` 点目录被排除；`getAdaptedVersions` 的惰性 `require('./version-service')` **不构成循环依赖**（version-service 不 require dsh-manager，且 require 在方法内、加载期无副作用）。
- **P7 测试增量扎实**：新增 `version-store-test.mjs` 57 项（含静态作用域守卫 `[K]`、EXDEV 注入 `[L]`、并发保护 `[H]`）；`dsh-version-validation-test` 34 项全绿。

---

## 六、针对四个审阅维度的直接回答

1. **并发与时序**
   - `inFlightFetch` **能有效聚合**并发请求（E2）。注意两点：(a) `force=true` 若撞上正在进行的 `force=false` fetch，会被合并进那次非强制请求（不会真正强刷，purge 也不触发）；(b) `.finally` 把 `inFlightFetch` 置空发生在微任务里，极小窗口内新请求会拿到已 settle 的旧 promise（无害）。
   - 懒加载 `require('./version-service')` **不会**循环引用，也**不会**在极端时序下产生模块级死锁；但存在**时序不确定性**：`getAdaptedVersions()`（不传 meta 时）读到的是"此刻的 `getLiveMeta()`"，其值取决于**别的请求是否已经预热过远端缓存**。同一进程内，安装前是否访问过 `/api/dsh/versions` 会改变 `isAdaptedVersion` 的判定依据（remote 规则 vs 本地规则）。建议安装路径显式传入同一份 meta 或统一从单一数据源取。
2. **缓存与容灾兜底**
   - 离线时 `_isRemoteMeta=false` + `cachedMeta=local` 的兜底**可靠**（本地 `version.json` 缺失时还有 `getLocalMeta()` 的完整内联兜底），但会锁 10 分钟（W8）。
   - TTL/304/脏数据：`fetch` 无 304 处理（Node undici 无 HTTP 缓存，实际不触发）；CDN 脏缓存的"严格更旧才跳过"守卫**不覆盖同版但内容陈旧**的情况，且 jsDelivr 通道无 cache-buster（S5）。
   - `isUsingRemoteMeta()` **不精确**：它是全局、非请求级标志，存在与所用 meta 不一致的竞态（W1/E3）；且 `/api/version/check` 完全没暴露该字段（W2）。
3. **接口语义与规范契约**
   - `level`/`title`/`message` 与前端消费逻辑**基本对齐**（`danger` → 红牌 + `[⛔ 不再兼容在线切换]`；`warning` 且标题/正文含"降级/会话" → `[⚠️ 会话降级风险]`；`isAdapted` 驱动深度适配徽章）。
   - `action` 从 `recommend-docker-pull` 改为 `''`：全仓库检索确认**无代码分支消费该值**（仅 `doc/compat/18-rc2-adaptation-assessment.md` 有历史引用），故不构成破坏；但 `doc/compat/*` 文档已与实现不一致，建议同步。
   - 预发布副作用：`0.1.7-rc.2` 命中 `<0.1.7-alpha.1` 与 `>=0.2.0` 均为 false → 正确落 `success`；`0.1.7`（正式版）落 `warning 未经特殊适配`、`0.1.7-rc.3` 同理，符合预期。**唯一隐患**是 `localeCompare` 对 `rc.10` 类版本排序错误（W3）与规则顺序（W4）。
4. **单元测试与向后兼容**
   - 三个相关测试**全部通过**，未破坏现有单测。
   - 隐性约束：(a) `version-matrix-sync-test` 强制 `version.json.adaptedVersions` 与 `dsh-manager.DEFAULT_ADAPTED_VERSIONS`/`version-service` 兜底/admin.html 三处兜底同步——未来任何"只改 version.json"的版本切换都会挂测；(b) `evaluateTargetVersion` 的内联兜底数组**不在**该测试覆盖内（S1）；(c) `gcVersions` 的 `installing` 守卫与 `installVersion` 的成功路径自锁（C1）；(d) `.dsh-rollback-preserved` 命名会被现有清理逻辑误杀（S10）；(e) 版本库跨镜像复用缺 `imageRevision` 校验（C2）。
