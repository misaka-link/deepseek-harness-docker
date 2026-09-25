# 控制台修改方案：引擎回滚点「可见 / 可删 / 默认留一份」（Lead × Gemini 联合）

> 需求（用户）：① 回滚点清理改为**手动**（探活通过后不再自动删除）；② **默认最多保存一份**；③ **「快照与备份」面板里要能删除引擎回滚点**。
> 参与方：Lead（deepseek-v4.1-flash）+ Gemini（newapi/gemini-3.8-flash）。
> 明细：Gemini 完整方案见 [console-plan-gemini.md](console-plan-gemini.md)；本文为**合并后的执行方案**（含分歧裁定）。
> 本轮只出方案，不含实现代码。

---

## 0. 结论摘要

1. **落点**：回滚点**留在容器层**，改名为受保护的 `.dsh-rollback-preserved`（单槽位）。
2. **策略**：探活通过后**不再自动删除**；新切换在**新版本探活通过后**才轮替旧备件；`DSH_ROLLBACK_KEEP` 默认 `1`（设 `0` 退回旧行为）。
3. **接口**：新增 `GET /api/dsh/rollback`、`DELETE /api/dsh/rollback`（切换中 409；`resolveWithinDir` 防穿越）。
4. **前端**：在「快照与备份」Tab 顶部新增**独立卡片**，与 17KB 用户快照严格分区；删除走 `askConfirm` 二次确认。
5. **必须同时修**：`entrypoint.sh` 与 `cleanupStagingOrphans` 会**无差别清理 >60min 的 `.dsh-rollback-*`**——不改这两处，"手动保留"会被后台静默抹杀。

---

## 1. 硬约束（已实测）

| 事实 | 证据 |
|---|---|
| 容器层（overlay）与快照卷是**不同设备** | `stat -c '%d'` → `/`=**113**，`/root/.dsh-snapshots`=**46** |
| 跨设备 `rename` 必 `EXDEV` → 只能 `cp -a`+`rm -rf` | 已在 `moveDirOrCopy()` 中处理 |
| 快照卷底层是 **ZFS**（有透明压缩） | `df -h` → `rpool/data/subvol-102-disk-0`；解释了 `du` 304M < 表观 456M |
| 同设备内**硬链接可用**（`cp -al` 生成 2 链接） | 远程实测通过（若将来要复用同一份拷贝，这是可行手段） |

---

## 2. 关键分歧与裁定：回滚点放容器层还是持久卷？

**Lead 初稿倾向持久卷**（这样容器重建后仍在，"手动管理"才有意义）；**Gemini 坚持容器层**。复核后 **采纳 Gemini**，理由如下：

| 维度 | 持久卷 `$DSH_SNAPSHOTS_DIR/...` | 容器层 `.dsh-rollback-preserved`（**采纳**） |
|---|---|---|
| 切换停机窗口 | ❌ `rename` 跨设备必失败 → **每次**切换都要 `cp -a` 477MB（~1.5–3s），且这段发生在 `await this.stop()` **之后**，直接拉长停服时间 | ✅ 同设备 `rename`，毫秒级 |
| 跨镜像可用性 | ❌ 镜像升级可能改 Node ABI；而 `_restoreFromRollbackDir()` **不做 ABI 校验**，还原后可能起不来 | ✅ 同容器 = 同 Node，天然无此风险 |
| 空间 | ❌ 若用户又勾了"归档当前引擎"，同一份内容在卷里存两遍（~1GB/次） | ✅ 不侵占持久卷 |
| 容器重建后 | ✅ 保留 | ❌ **随容器消亡**（`pull && up -d` 后即失） |
| 长期保留需求 | ✅ | ✅ 已由 `$DSH_SNAPSHOTS_DIR/versions`（版本归档）承接 |

**裁定**：容器层单槽位。持久化需求由**版本归档**承接，两者职责不重叠——回滚点=**当前容器会话内的应急刹车片**，归档=**跨世代的免下载库**。

> ⚠️ **需要用户知晓的代价**：容器重建 / 镜像更新后回滚点会消失（这不是"系统自动清理"，而是容器可写层重置）。UI 必须写明这一点，避免用户以为"我留着的东西被系统删了"。

---

## 3. 保留与轮转策略

**"默认最多一份"与"手动清理"的张力**：若严格"系统永不删"，第二次切换时就会出现 2 份、3 份……无界增长。

**规则（滑动单槽位）**：
1. **就绪态静默保留**：切换成功且探活通过后，**不删除**回滚点（改掉现在的 `_disposeRollbackDir`）。
2. **新切换触发轮替**：发起下一次切换时，**在新版本探活通过之后**，才把旧备件换成本次换下的核心。**绝不在新版就绪前删旧备件**——否则本次失败就没得回滚。
3. **可配置**：`DSH_ROLLBACK_KEEP`（默认 `1`；`0` = 退回"探活通过即清理"的旧行为，供小磁盘环境）。

---

## 4. 必须同步修的"误杀"隐患（Critical，Gemini 发现）

现在有两处会**无差别**清理超过 60 分钟的回滚点目录：

```bash
# scripts/entrypoint.sh:105 —— 容器每次重启都会执行
find "${CORE_PARENT}" -maxdepth 1 -name ".dsh-rollback-*" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
```
```js
// gateway/dsh-manager.js —— cleanupStagingOrphans()（启动/GC 时调用）
if (!isStoreStaging && !/^\.dsh-(staging|rollback)-/.test(name)) continue;
```

**不改这两处，"手动保留"最多活 60 分钟**。

**修法**（注意：**只改名不够**，`.dsh-rollback-preserved` 依然会被 `-name ".dsh-rollback-*"` 和 `/^\.dsh-(staging|rollback)-/` 命中，必须显式排除）：
- 临时目录继续用 `.dsh-rollback-tmp-<pid>-<ts>`（可被清理）；
- 正式备件用 `.dsh-rollback-preserved`；
- `entrypoint.sh`：`find ... -name ".dsh-rollback-*" ! -name ".dsh-rollback-preserved" ...`；
- `cleanupStagingOrphans()`：显式 `if (name === '.dsh-rollback-preserved') continue;`；
- `entrypoint.sh:95-100` 的核心缺失自愈：**优先**用 `-tmp-` 目录还原，找不到再用 `preserved`（保命优先于保留）。

---

## 5. 后端 API（`gateway/index.js` + `gateway/dsh-manager.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/dsh/rollback` | `{ ok, exists, rollback: { version, sizeBytes, sizeFormatted, createdAt, nodeAbi, abiMatches, path, canRestore } \| null }` |
| `DELETE` | `/api/dsh/rollback` | 200 `{ ok, freedBytes }`；**切换中 → 409**；不存在 → 404 |
| `POST` | `/api/dsh/rollback/restore` | **（待定，见 §10）** 就地还原 |

- 路径一律经 `resolveWithinDir(LIVE_CORE_PARENT, ...)`；版本号经 `isValidVersion`。
- 复用现有 `installing` 并发保护（与 `gcVersions` / `deleteCachedVersion` 同款）。
- **加固建议（Lead 补充）**：`_restoreFromRollbackDir()` 增加 `isReadyVersionDir()` 校验，ABI 不匹配时拒绝还原并明确报错——即使容器层理论上不会 ABI 漂移，这也是一道纵深防御。

---

## 6. 前端（`gateway/public/admin.html` → `#tab-snapshots`）

**不混排**（Gemini 主张，采纳）：现有 `snapshotsTableBody` 管的是用户配置数据（17KB~10MB，可导出/导入/迁移），回滚点是系统引擎备件（477MB，不可下载迁移），混在一起会误导。

**双卡片**：
```
┌ 🛠️ 核心引擎就地回滚点（系统备件）          单份槽位 1/1 ┐
│ [稳定备件] v0.1.7-rc.1 · 477MB · 创建于 2025-02-23 10:15 │
│ 运行环境: ✔ Node ABI 匹配                                │
│                       [ ⚡ 还原此版本 ]  [ 🗑️ 清理 (释放477MB) ] │
└──────────────────────────────────────────────────────┘
┌ 📦 DSH 用户数据与配置快照（现有表格，不动）             ┐
```
- 空态：`ℹ️ 当前未保留引擎回滚点（下次切换成功后会自动暂存前序版本）`
- 卡片说明必须写明：**容器重建/镜像更新后此备件会失效**（见 §2 的代价）。
- 删除二次确认（复用 `askConfirm`）：标题「确认清理核心引擎回滚点？」，正文给出**释放空间**与**失去秒级撤销保障**两个后果。

---

## 7. 与切换流程的交互

- **切换前弹窗**（`#switchConfirmModal`）：若已有回滚点，增加一行「本次切换成功后，现有回滚点 vX（477MB）将被轮替，不额外占用空间」。
- **切换中**：面板删除按钮 `disabled`；后端 409。
- **切换后**：SSE `done` 触发 `loadRollbackStatus()` 刷新卡片；日志改为「前序核心已转为就地回滚点保留，如需释放空间请到【快照与备份】面板手动清理」。

---

## 8. 边界与风险

- **磁盘**：保留一份回滚点 = 常驻 ~477MB（ZFS 实际占用更小）；切换瞬间还会同时存在 活动核心 + 临时回滚点 + 保留备件。`_assertDiskSpace` 需覆盖，且磁盘不足时提示「可先到面板清理回滚点释放 477MB」。
- **并发**：`installing` 期间禁止删除。
- **容器重建**：容器层备件消失 → 面板回空态；持久归档不受影响。
- **孤儿**：`-tmp-` 残留仍由 60 分钟规则清理；`preserved` 豁免。
- **自愈**：核心缺失时 entrypoint 优先用 `-tmp-`、其次 `preserved` 还原。

---

## 9. 验收清单（可观察、可判定）

- [ ] 切换成功后 `ls -d .../.dsh-rollback-preserved` **仍存在**，日志提示"已转为就地回滚点保留"
- [ ] 面板卡片显示 版本 / 体积 / 创建时间 / ABI 徽标，体积与实测一致
- [ ] `DELETE /api/dsh/rollback` → 200，目录消失，卡片回空态，`df` 可见释放
- [ ] 切换进行中 `DELETE` → **409**
- [ ] 已有备件时再次切换 → 成功后容器内 `.dsh-rollback-preserved` **仍只有 1 个**，且内容是刚换下的版本
- [ ] **`docker restart` 与触发 GC 后，备件仍在**（防误杀，T7）
- [ ] 容器重建后：备件消失、面板回空态、持久归档仍在
- [ ] 探活失败仍能从回滚点秒级还原（不受"保留"改动影响）
- [ ] 恶意路径请求被 `resolveWithinDir` 拦截

---

## 10. 待用户拍板

1. ~~是否接受"回滚点随容器重建消失"？~~ → **已定：接受不持久化，落点=容器层单槽位 `.dsh-rollback-preserved`**（用户 2026-09-24 决定，视为优点：容器重建=干净世代，不会带进跨镜像 ABI 污染）。
2. ~~要不要「⚡ 还原此版本」按钮？~~ → **已定：做**。已实现（`restoreRollbackPoint`）。
3. ~~`DSH_ROLLBACK_KEEP` 要不要暴露到设置页？~~ → **已定：不要这个开关**，写死"保留 1 份"。

## 11. 实现与验收结果（已交付）

实现：Gemini（`newapi/gemini-3.8-flash`），审核：Lead。

- **本地回归**：`version-store-test` **86/86**（新增 `[M]` 回滚点治理与就地还原 8 项子测试）、`dsh-version-validation` 34/34、`version-matrix-sync` 28/28、`setup-gate` 30/30、`frontend-plugin-fixes` 21/21。
- **远程端到端**：`scripts/remote-verify-issue7.sh` **PASS=34 / FAIL=0 → ISSUE7_VERIFY_OK**，其中 `[3]`/`[6.7]` 覆盖：
  - 切换成功后**前序核心被保留**为就地回滚点（不再自动删除），且无 `.dsh-rollback-tmp-*` 残留；
  - `GET /api/dsh/rollback` 正确报告版本 / 体积（411.7 MB）/ 创建时间 / `abiMatches` / `canRestore`；
  - **就地还原成功**：活动版本 A → 切到 B → 还原 → 回到 A，且槽位轮替为 B（天然支持"撤销还原"）；
  - `DELETE` 手动清理成功并报告释放字节，重复删除被拒。
- **关键防御（Lead 逐条核对）**：`entrypoint.sh` 的 `! -name ".dsh-rollback-preserved"`、`cleanupStagingOrphans` 的显式 `continue` 豁免、路由 409/404/400 语义、还原失败时原备件不被破坏（`[M8]` 实测覆盖）。
- **夹具修正**：验证脚本原先硬编码"出厂版本 `0.1.7-rc.1`"，在 `version.json` 升级到 `rc.2` 后失效；已改为运行时动态探测 `V_BASE`，避免版本漂移导致误报。


