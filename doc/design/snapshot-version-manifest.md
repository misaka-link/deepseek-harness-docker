# 快照版本元数据规范与还原兼容性判定 · 技术设计

> 议题：DSH 配置文件格式跨版本不兼容（0.1.6 之前 `settings.yaml`；0.1.7 起迁移到 `cordis.patch.yml` 补丁层，旧 `settings.yaml` 一次性导入并改名 `settings.yaml.imported`）。
> 需求：(1) 创建配置/备份快照时标记 DSH 版本；(2) 还原时能检测、提取、提示适用版本并评估与当前系统的兼容性。
> 涉及模块：`gateway/backup-service.js`、`gateway/dsh-manager.js`、`gateway/index.js`（新增 `gateway/snapshot-manifest.js`）。

---

## 0. 角色与运行模型声明

- **角色**：资深后端架构师（本议题的设计与实现方案负责人）。
- **实际运行模型**：**deepseek-v4.1-flash**（DeepSeek Harness 运行时；由 DSH 会话配置决定）。
- 本设计中的所有命令行行为均已在本容器内实测（`tar` 成员顺序、`--occurrence=1` 快速读取、`validateArchiveMembers` 放行、sidecar 缓存、旧快照推断、YAML 打戳幂等），参考实现见 [`gateway/snapshot-manifest.js`](../../gateway/snapshot-manifest.js)。

---

## 1. 背景：为什么必须在归档里带版本

### 1.1 当前快照链路的盲区

现状（`gateway/backup-service.js`）：

| 位置 | 行为 | 问题 |
|---|---|---|
| `createBackup()` (`:236`) | `tar -cf <tmp> -C /root .dsh` | 归档里**没有任何版本标识**；产出物只靠文件名 `dsh-snapshot-<ts>-<name>.tar.gz` 区分 |
| `listBackups()` (`:593-622`) | 只 `stat` 文件名/大小/mtime | 列表**不读归档内容**，无法显示「这是哪个 DSH 版本」 |
| `restoreBackup()` (`:284`) | 先 `validateArchiveMembers`，再解压 staging、原子切换 | **不校验版本**；0.1.6 的 `settings.yaml` 快照可直接灌进 0.1.7 系统（会被一次性导入，语义已变），0.1.7 的 `cordis.patch.yml` 快照灌进 0.1.6 系统则**补丁层被完全忽略 → 静默配置丢失** |
| `importBackupStream()` (`:473`) | 只校验 gzip 魔数 + 成员白名单 | 外部导入的归档同样无版本概念 |

版本在 `gateway/dsh-manager.js` 里是**可得**的：`getCurrentVersion()` (`:594-626`) 已实现「`package.json` → `dsh --version` → `version.json supply.dshVersion` 兜底」的探测链，并缓存到 `this.lastKnownVersion`。缺的是「把它写进归档」和「还原前读出来比对」。

### 1.2 配置模型世代（核心轴）

官方 0.1.7 起，设置权威从 `$DSH_HOME/.dsh/settings.yaml` 迁移到**补丁层**（profile 级 `profiles/web/cordis.patch.yml` + Home 级 `$DSH_HOME/.dsh/cordis.patch.yml`），旧 `settings.yaml` 只在 DSH 启动、Loader settle 后**导入一次并改名 `settings.yaml.imported`**（见 `doc/compat/02-config-model-audit.md` §2.1、`scripts/entrypoint.sh:81-86`）。

因此「版本兼容」不能只看 SemVer，必须同时看**配置模型世代**：

| 世代 | `schemaVersion` | 触发版本 | 权威文件 |
|---|---|---|---|
| settings-file | `1` | `< 0.1.7-alpha.1` | `.dsh/settings.yaml` |
| patch-layer | `2` | `>= 0.1.7-alpha.1` | `.dsh/cordis.patch.yml`、`profiles/*/cordis.patch.yml` |

**单向不兼容矩阵**：

| 快照世代 → 还原到 | 结果 |
|---|---|
| `1`（settings.yaml）→ `1` | ✅ 直接可用 |
| `2`（patch-layer）→ `2` | ✅ 直接可用 |
| `1` → `2`（旧→新） | ⚠️ `settings.yaml` 被一次性导入，之后以补丁层为权威；**导入表外的 section 会被丢弃**，且导入后原文件改名，不可重复导入 |
| `2` → `1`（新→旧） | ⛔ `cordis.patch.yml` 不被旧引擎识别 → **补丁层配置静默失效** |

---

## 2. 方案总览

```
┌───────────────────────── createBackup() ─────────────────────────┐
│ 1. 解析版本上下文 VersionContext                                    │
│    dshManager.getCurrentVersion() ─┐                               │
│    gateway/package.json version  ─┼─► { dshVersion, projectVersion,│
│    version.json compatibility.*  ─┘     imageRevision, schemaVersion}│
│ 2. buildManifest() + finalizeManifest()  → manifest 对象            │
│ 3. 写 staging：<stage>/.dsh/.dsh-meta/snapshot.json                 │
│ 4. tar 打包（manifest 作为**首个成员**，仍在 .dsh/ 之下）             │
│ 5. 原子 rename 转正 + 写 sidecar .<file>.meta.json（含 archive 指纹）│
└──────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
  listBackups()                                 restoreBackup()
  读 sidecar（O(1)）→ 返回 dshVersion 等      1. inspectArchive()：sidecar → 归档内 manifest → 结构推断
  缺失/过期 → 懒检视一次并回填                 2. assessCompatibility(快照, 当前) → verdict
                                              3. verdict.requiresAcknowledgement 时要求前端显式确认
                                              4. 校验通过 → 解压 staging → 原子切换（现有流程不变）
```

设计原则：
1. **fail-closed 不放宽**：元数据放在 `.dsh/` 之下，`validateArchiveMembers()` 一字不改即可放行（已实测）。
2. **不阻塞、不爆内存**：所有 tar 读取走异步 `spawn` + 超时 + 输出上限（复用 `runTarAsync` 的既有范式）。
3. **元数据只是元数据**：任何解析失败都降级为「未知版本 + 警告」，绝不因元数据损坏而阻断一个本身合法的归档（安全判定仍由 `validateArchiveMembers` 负责）。
4. **单一数据源**：兼容规则复用 `version.json` 的 `compatibility.rules` 与 `adaptedVersions`，避免第 4 份漂移清单（`dsh-manager.js:85-119` 已因漂移踩过坑）。

---

## 3. 备份元数据规范（Snapshot Manifest Schema）

### 3.1 存放位置与命名决策

候选：
- ❌ `.<filename>.meta.json` 放在 `SNAPSHOTS_DIR` 作为**唯一**元数据 → 一旦 sidecar 丢失（跨机拷贝只拷 `.tar.gz`、磁盘清理）元数据即永久丢失，且导入外部归档时对方不会带。
- ❌ 归档根目录放 `.dsh-snapshot-meta.json` → **成员超出 `.dsh/` 前缀**，被 `validateArchiveMembers()` 直接拒绝（`backup-service.js:142-144`）。
- ✅ **归档内** `.dsh/.dsh-meta/snapshot.json`（普通文件，位于 `.dsh/` 之下 → 白名单天然放行；已实测 `VALIDATE OK { members: 5 }`）
  **＋ sidecar** `SNAPSHOTS_DIR/.<filename>.meta.json`（加速列表读取，可随时重建）。

> 说明：任务描述里的 `.dsh/snapshot-manifest.json` 也可用，但会与 DSH 未来可能的 `settings.yaml`/`cordis.patch.yml` 同层命名空间混在一起；放进专属隐藏子目录 `.dsh/.dsh-meta/` 更干净，且便于「还原后清理」与「打包前清理」用**一个目录名**完成（见 §4.4）。

### 3.2 Manifest 字段规范（`manifestVersion = 1`）

```jsonc
{
  // ── A. 身份与来源（必填） ─────────────────────────────────────────
  "manifestVersion": 1,                 // int，本 JSON 格式版本；字段增删时 +1
  "generator": "deepseek-harness-docker/gateway/backup-service",
  "generatorVersion": "0.1.8",          // 套件（本项目）版本，读 gateway/package.json
  "dockerSuiteVersion": "0.1.8",        // = generatorVersion 的显式别名，供前端直读
  "imageRevision": "proj0.1.8-dsh0.1.7-rc.1", // 镜像修订号（dsh-manager.js:165-169 的 IMAGE_REVISION 同构）

  // ── B. 版本轴（必填，判定核心） ────────────────────────────────────
  "dshVersion": "0.1.7-rc.1",           // 快照产生时**实际运行**的 DSH 引擎版本
  "dshVersionSource": "package.json",   // injected|package.json|probe|cli|fallback|unknown|inferred
  "schemaVersion": 2,                    // 配置模型世代：1=settings-file, 2=patch-layer
  "configModel": "patch-layer",          // schemaVersion 的字符串投影（便于人读/前端）

  // ── C. 归档属性（必填） ───────────────────────────────────────────
  "backupType": "full",                 // full | config
  "createdAt": "2026-09-24T16:23:45.123Z",
  "createdAtEpochMs": 1758731025123,
  "name": "manual",                     // 经 sanitizeName 的备注

  // ── D. 兼容区间（快照时刻的供应链声明，作为历史事实留档） ──────────
  "compatibilityRange": {
    "recommendedDsh": "0.1.7-rc.2",
    "supportedDshRange": ">=0.1.2-rc.1 <=0.1.7-rc.2",
    "adaptedVersions": ["0.1.7-rc.2", "0.1.7-rc.1", "..."]
  },

  // ── E. 内容指纹（用于「里面有没有某个配置文件」快速判断 + 旧快照推断） ─
  "contents": {
    "hasSettingsYaml": false,
    "hasSettingsImported": true,
    "hasCordisPatchYml": true,
    "hasProfilesDir": true,
    "hasSessions": true,
    "hasCredentials": true
  },

  // ── F. 宿主环境（跨机还原排障，选填） ─────────────────────────────
  "host": { "node": "v22.14.0", "platform": "linux", "arch": "x64", "dshHome": "/root" },

  // ── G. 归档统计（选填，创建后回填 sidecar） ────────────────────────
  "archive": { "format": "tar.gz", "compression": "pigz", "memberCount": 28791 },

  // ── H. 完整性（必填 manifestSelfHash；其余选填） ───────────────────
  "filesHash": {
    "algorithm": "sha256",
    "manifestSelfHash": "3d7b22a4…",   // 覆盖除本字段外全部字段的规范化 JSON 摘要
    "configTreeHash": null,             // 选填：配置树（排除 sessions/node_modules）摘要，异步计算
    "fileCount": 28791,
    "totalBytes": 538000000
  }
}
```

字段设计要点：

| 字段 | 为什么需要 |
|---|---|
| `dshVersion` | 还原判定第一输入；必须来自**运行时真实版本**而非镜像出厂值（镜像可在线切换引擎，`version.json.supply.dshVersion` 会滞后） |
| `dshVersionSource` | 区分「确证」与「兜底/推断」，前端据此显示置信度（`package.json`=确证，`fallback`/`inferred`=需人工确认） |
| `schemaVersion` | 兼容判定的**第二轴**；跨世代比 SemVer 差异更致命（见 §1.2 矩阵） |
| `imageRevision` | 同一 `dshVersion` 可能出现在不同套件镜像里（`dsh-manager.js:162-169` 注释已点明），用于诊断「归档来自哪个镜像」 |
| `compatibilityRange` | 保留快照产生时刻的官方兼容窗口，历史可追溯；避免用**当前** version.json 去解释**过去**的快照 |
| `contents` | 免解压即可回答「这是不是 config-only / 有没有 settings.yaml」；也是旧快照推断的输入 |
| `manifestSelfHash` | 检测 manifest 被篡改/截断；`restore` 时用于「前端确认的版本 == 实际要还原的版本」的 TOCTOU 校验 |

**字段缺失策略（向前兼容）**：读取方必须容忍任意字段缺失 —— `dshVersion` 缺失 → `UNKNOWN_VERSION`；`schemaVersion` 缺失 → 用 `dshVersion` 反推（`configSchemaForDshVersion`）；`manifestVersion` 更高 → 只读已知字段并提示「元数据来自更新版本套件」。

---

## 4. 生成备份时的版本标记流程

### 4.1 版本上下文解析（VersionContext）

`createBackup()` 目前签名是 `(nameOrOpts, backupType)`，**拿不到 dshManager**。且 `backup-service.js` 不能直接 `require('./dsh-manager')`（dsh-manager 已 `require('./backup-service')` → 循环依赖）。采用**依赖注入 + 兜底链**：

```js
// backup-service.js
let versionProvider = null;                 // 由 index.js 注入
function configure(opts = {}) {
  if (typeof opts.getDshVersion === 'function') versionProvider = opts.getDshVersion;
}
// index.js 启动时：
// backupService.configure({ getDshVersion: () => dshManager.getCurrentVersion() });

const DSH_PKG_PATHS = [
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
];

function resolveDshVersion() {
  // ① 注入的 dshManager.getCurrentVersion()（最权威：含 lastKnownVersion 缓存与 CLI 探测）
  if (versionProvider) {
    try { const v = versionProvider(); if (isValidVersion(v)) return { version: v, source: 'injected' }; } catch {}
  }
  // ② 直接读活动核心 package.json
  for (const p of DSH_PKG_PATHS) {
    try { const v = JSON.parse(fs.readFileSync(p, 'utf8')).version; if (isValidVersion(v)) return { version: v, source: 'package.json' }; } catch {}
  }
  // ③ version.json 供应链固定版本（兜底，标注 fallback）
  const meta = readVersionMeta();
  const v = meta?.supply?.dshVersion;
  if (isValidVersion(v)) return { version: v, source: 'fallback' };
  return { version: null, source: 'unknown' };
}
```

> 注意与 `dshManager.getCurrentVersion()` 保持**同一判定口径**：它读 `LIVE_CORE_DIR/package.json` → `/usr/local/...` → `/opt/...` → `dsh --version`。注入优先即自动继承。`version.json` 的 `supply.dshVersion` 只作最后兜底并显式标注 `source: 'fallback'`，避免把「镜像出厂版本」误当成「当前运行版本」。

`projectVersion` 取 `gateway/package.json` 的 `version`（`version-service.getLocalProjectVersion()` 同源）；`compatibilityRange` 取 `version.json.compatibility`。

### 4.2 组装与自指纹

```js
function buildSnapshotMeta(ctx) {
  const meta = buildManifest({
    dshVersion: ctx.dshVersion,
    dshVersionSource: ctx.dshVersionSource,
    projectVersion: ctx.projectVersion,        // gateway/package.json#version
    imageRevision: ctx.imageRevision,          // 复用 dsh-manager 的 IMAGE_REVISION 口径
    schemaVersion: configSchemaForDshVersion(ctx.dshVersion),   // 由版本反推世代
    backupType: ctx.backupType,
    name: ctx.name,
    compatibilityRange: ctx.compatibilityRange, // version.json#compatibility
    contents: ctx.contents,                     // 打包前对 DSH_DIR 采样得到
    host: { node: process.version, platform: process.platform, arch: process.arch, dshHome: DSH_HOME }
  });
  return finalizeManifest(meta);                // 写入 filesHash.manifestSelfHash
}
```

`contents` 在打包前对现网采样（`fs.existsSync`，零成本）：`settings.yaml`、`settings.yaml.imported`、`cordis.patch.yml`、`profiles/`、`sessions/`、`.credentials.yaml`。

### 4.3 无缝注入 tar.gz 且通过白名单校验（★ 已实测）

**关键约束**：`validateArchiveMembers()` 要求**所有成员都位于 `.dsh/` 之下**（`:142-144`），且只允许普通文件/目录/受控链接（`:151-166`）。因此 manifest 必须落在 `.dsh/` 内。

**关键技巧**：GNU tar 允许在文件操作数之间**交错多个 `-C`**，从而把「元数据源」与「配置源」合成一个归档，且可控制成员顺序：

```bash
# stage/.dsh/.dsh-meta/snapshot.json 为本次生成的 manifest
tar --warning=no-file-changed \
    --exclude=.dsh/.pnpm-store --exclude='**/node_modules/.cache' \
    --exclude=.dsh/tmp --exclude=.dsh/gateway.config.json \
    -I pigz -cf "$tmpPath" \
    -C "$manifestStage" .dsh/.dsh-meta/snapshot.json \   # ← 先放 manifest（首位）
    -C /root .dsh                                        # ← 再放配置树
```

实测结果：

```
--- member order ---
.dsh/.dsh-meta/snapshot.json      ← 首位！
.dsh/
.dsh/profiles/
.dsh/profiles/web/package.json
.dsh/cordis.patch.yml
--- fast read (occurrence=1) ---
{"dshVersion":"0.1.7-rc.1","schemaVersion":2}      exit=0
--- validateArchiveMembers ---
VALIDATE OK { members: 5 }
```

为什么 manifest 放**首位**很重要：gzip 是流式压缩，`tar -xzOf` 必须从头顺序解压；成员在首位时命中即停（`--occurrence=1`），读取成本与归档体积**无关**。这样即使 sidecar 丢失（例如别人只拷了 `.tar.gz`），检视也是近乎瞬时的。

**`-C` 语义坑（实测）**：`-C` 是**相对当前 `-C` 链**解析的，混用相对路径会失败（`tar: live：无法 open`）。因此注入 stage 与 `/root` 时**必须用绝对路径**。

**重复成员防护**：GNU tar 的 `--exclude` 是**全局**的，会连注入的 manifest 一起排除，因此**不能**用 `--exclude=.dsh/.dsh-meta` 来去重。改为**前置清理**（见 §4.4）：打包前确保 live 树不存在 `.dsh/.dsh-meta/`（还原流程也会清理），从源头杜绝重名成员（重复成员会导致后出现的旧成员覆盖新成员）。

**备选方案**（不推荐，仅记录）：
- `tar -rf` 追加：GNU tar 不支持向 gzip 归档追加（`cannot update compressed archives`）。
- 先打未压缩 tar → 追加 manifest → 再 pigz：可行，但需一份完整未压缩 tar 落盘（数百 MB~GB），I/O 翻倍，**放弃**。
- 写 live `/root/.dsh/.dsh-snapshot-meta.json` → 打包 → 删除：简单但**污染 live 配置目录**、崩溃会留残渣，且成员顺序不可控（readdir 顺序），**仅作降级**。

### 4.4 打包前清理（防御性）

```js
// createBackup() 打包前：
const staleMetaDir = path.join(DSH_DIR, '.dsh-meta');
try { fs.rmSync(staleMetaDir, { recursive: true, force: true }); } catch {}
```

`.dsh-meta/` 是「归档自有」目录（archive-owned），live 树不应长期保留它。还原流程在切换完成后同样删除 `.dsh/.dsh-meta/`（见 §6.6），保证不变量成立。

### 4.5 单独导出的配置文件如何打版本标识

`gateway.config.json` 与 `cordis.patch.yml` 会**单独**被导出/下载（不经 tar），因此需要**文件内**版本标识：

**(a) `gateway.config.json`（JSON，加保留键）**

```js
// index.js: 写 CONFIG_FILE 前统一过一道
const stamped = stampJsonConfig(configObj, versionCtx);
// → { ...原有字段, "_snapshotMeta": { dshVersion, schemaVersion, configModel,
//      dockerSuiteVersion, imageRevision, stampedAt, note } }
```

`_snapshotMeta` 以 `_` 前缀 + 单独命名空间，不进入任何业务读取路径（`index.js:32` 的 `CONFIG_FILE` 解析处按需忽略即可）；JSON 允许未知键，向后兼容。读取用 `readJsonStamp(obj)`。

**(b) `cordis.patch.yml` / `settings.yaml`（YAML，加注释块）**

YAML 注释不参与解析，因此**零语义污染**；且必须**幂等**（重复保存不叠加）：

```yaml
# >>> dsh-snapshot-meta (auto-generated, do not edit) >>>
# dshVersion: 0.1.7-rc.1
# schemaVersion: 2
# configModel: patch-layer
# dockerSuiteVersion: 0.1.8
# imageRevision: proj0.1.8-dsh0.1.7-rc.1
# stampedAt: 2026-09-25T00:06:48.436Z
# <<< dsh-snapshot-meta <<<
- id: ui-sidebar-browser
```

`stampYamlText()` 先 `stripYamlStamp()` 删旧块再写新块（实测：重复打戳后标记块仍只有 1 个，正文逐字保留，`stripYamlStamp` 可完全还原原文）。

> ⚠️ 对 `cordis.patch.yml` 打戳要与既有「外科手术式 YAML 编辑」保持一致：`scripts/patch-yaml.cjs` 只删命中条目的字符区间、其余字节逐字保留。注释块写在文件**头部**、且 `stripYamlStamp` 使用整块正则，不会误伤任何条目；写入仍走 `writeFileAtomic` + 锁（`/root/.dsh/cordis.patch.yml.lock`）。

---

## 5. 快照列表与元数据快速读取

### 5.1 三层读取策略

```
listBackups() 单个快照：
 ① sidecar 命中且新鲜（size+mtime 双比对） ──► O(1) readFileSync，直接返回
 ② sidecar 缺失/过期 ──► inspectArchive()：
      2a. tar -xzOf --occurrence=1 .dsh/.dsh-meta/snapshot.json   （manifest 在首位，近 O(1)）
      2b. 无 manifest ──► tar -tzf 列成员 → inferFromMembers()（旧快照，一次）
     ──► 回填 sidecar（原子写），下次走 ①
```

**为什么不能只用 ②**：`tar -tzf` 对 300MB 归档要全量解压（28k+ 成员，秒级且阻塞 I/O），`listBackups()` 是**列表接口**、会被前端轮询（`admin.html:4342` 的 `loadSnapshots`），不能每次全量解压。**sidecar 是列表性能的关键**，②只作为 sidecar 丢失后的自愈路径。

### 5.2 sidecar 规范

- 路径：`SNAPSHOTS_DIR/.<filename>.meta.json`（隐藏文件 → 被 `listBackups` 的 `f.endsWith('.tar.gz') && !f.startsWith('.')` 双重过滤，**不污染快照列表**）。
- 内容：
  ```jsonc
  {
    "meta": { /* 完整 manifest 或推断结果 */ },
    "metaSource": "sidecar|inline|inferred",
    "confidence": "high|medium|low|none",
    "verified": true,                    // manifestSelfHash 校验结果
    "archive": { "sizeBytes": 538000000, "mtimeMs": 1758731025123 }, // 新鲜度指纹
    "archiveSha256": null,               // 选填：创建后异步流式计算
    "cachedAt": "2026-09-24T16:24:01.000Z"
  }
  ```
- **新鲜度**：`sidecarIsFresh()` 比对 `sizeBytes` 与 `mtimeMs`；文件被替换/重打（大小或 mtime 变）→ 缓存失效 → 重新检视。归档是**一次性写入后只读**的（`renameSync` 转正），该判据足够强。
- **原子写**：`.tmp` + `renameSync`（与快照转正同范式，`backup-service.js:257`）。
- **生命周期**：`deleteBackup()` 同步删 sidecar（否则孤儿 sidecar 会累积）；`importBackupStream()` 导入后立即检视并回填 sidecar。

### 5.3 `listBackups()` 改造（保持向后兼容）

```js
function listBackups() {
  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.tar.gz') && !f.startsWith('.'));
  const list = files.map(filename => {
    const stat = fs.statSync(path.join(SNAPSHOTS_DIR, filename));
    const sc = readSidecar(SNAPSHOTS_DIR, filename);
    const fresh = sc && sidecarIsFresh(sc, stat);
    const meta = fresh ? sc.meta : null;
    const isConfig = (meta && meta.backupType === 'config')
      || filename.startsWith('dsh-config-') || filename.includes('-config-') || filename.includes('_config_');
    return {
      // —— 既有字段，一个不改（前端与 ensureDefaultSnapshot 依赖它们） ——
      filename, type: isConfig ? 'config' : 'full',
      typeLabel: isConfig ? '仅配置 (无会话)' : '完整备份',
      sizeBytes: stat.size, sizeFormatted: `${(stat.size/1024/1024).toFixed(2)} MB`,
      createdAt: (meta && meta.createdAt) || stat.mtime.toISOString(),
      // —— 新增字段（可空，前端按需渲染） ——
      dshVersion: meta ? meta.dshVersion : null,
      dshVersionSource: meta ? meta.dshVersionSource : null,
      dockerSuiteVersion: meta ? (meta.dockerSuiteVersion || meta.generatorVersion) : null,
      schemaVersion: meta ? meta.schemaVersion : null,
      configModel: meta ? meta.configModel : null,
      metaSource: meta ? (sc.metaSource || 'sidecar') : 'pending',   // pending=需要懒检视
      confidence: meta ? sc.confidence : null
    };
  }).filter(Boolean).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { ok: true, snapshots: list, activeTask: getActiveTask() };
}
```

**懒检视（可选增强）**：列表接口**不做**同步 tar 读取（会阻塞）。对 `metaSource === 'pending'` 的项，可由前端异步调用 `/api/snapshots/inspect` 逐条补全；或后端在 `setImmediate` 中后台预热 sidecar（受 `activeTask` 互斥保护，避免与备份/还原抢 I/O）。

---

## 6. 还原时的版本兼容性判定

### 6.1 流程

```js
async function restoreBackup(filename, dshManager, opts = {}) {
  // 0. 文件名与存在性校验（不变）
  // 1. 【新增】白名单校验（不变）→ 版本检视
  await validateArchiveMembers(snapshotPath);
  const inspection = await inspectArchive(snapshotPath, { snapshotsDir: SNAPSHOTS_DIR, filename: safeFilename });

  // 2. 【新增】与当前系统比对
  const current = {
    dshVersion: dshManager ? dshManager.getCurrentVersion() : resolveDshVersion().version,
    schemaVersion: detectCurrentSchema(),     // 见 6.3
    projectVersion: versionService.getLocalProjectVersion()
  };
  const verdict = assessCompatibility(inspection.meta, current, { rules: loadCompatRules() });

  // 3. 【新增】门禁
  if (opts.expectMeta && !metaMatches(opts.expectMeta, inspection.meta)) {
    throw new Error('快照元数据在确认后发生变化，已中止还原（请重新检视）');   // TOCTOU 防护
  }
  if (verdict.requiresAcknowledgement && opts.acknowledgeMeta !== true) {
    const e = new Error(`版本兼容性需要确认: [${verdict.level}] ${verdict.messages[0]?.title || ''}`);
    e.code = 'VERSION_ACK_REQUIRED'; e.verdict = verdict;
    throw e;                                   // 前端拿到结构化 verdict → 二次确认后带 acknowledgeMeta:true 重试
  }
  if (verdict.level === 'danger' && opts.force !== true) {
    const e = new Error(`检测到严重版本不兼容，已阻止还原: ${verdict.messages[0]?.title || ''}`);
    e.code = 'VERSION_DANGER'; e.verdict = verdict;
    throw e;                                   // 需 force:true（前端红色强警告二次确认）
  }

  // 4. 优雅停 DSH → 解压 staging → 原子切换（现有流程不变，见 :307-389）
  // 5. 【新增】切换成功后清理 .dsh/.dsh-meta/（归档自有的元数据不留在 live 树）
  // 6. pnpm 补全 / 权限自愈 / install-plugin / boot（不变）
  // 7. 返回体带上 verdict 与快照版本，便于前端展示
  return { ok: true, filename: safeFilename, dshReady, snapshotVersion: inspection.meta?.dshVersion ?? null, verdict };
}
```

> **门禁策略取舍**：`warning`/`unknown` 需**显式确认**（`acknowledgeMeta`）；`danger`（主版本不一致、新→旧世代、`>=0.2.0` 架构重构）需**强确认**（`force`）。采用「可强制放行」而非硬阻断：快照是用户自己的数据，必须留逃生通道（尤其灾难恢复场景）；但默认 fail-closed，且 `>=0.2.0` 规则沿用 `version.json` 的 `action: force-docker-pull` 提示换镜像。

### 6.2 兼容性判定算法（`assessCompatibility`）

```
输入：snapshotMeta, current{dshVersion,schemaVersion}, rules[]
输出：verdict{ level, code, snapshot, current, messages[], requiresAcknowledgement, canProceed }

level 取值：ok < info < warning < danger ；unknown 视作 warning 级
取最严重者（monotonic bump）

步骤：
1) 版本号可解析性
   if !isValidSemver(snapVer) || !isValidSemver(curVer):
       code = UNKNOWN_VERSION; level ≥ unknown
       msg = 推断置信度 + 推断适用区间（旧快照）
   else 比较 cmp = compareSemver(snapVer, curVer)：
       cmp == 0                          → EXACT_MATCH   （ok）
       same major && same minor          → PATCH_DIFF    （info）
       same major, minor 不同            → MINOR_DOWNGRADE / MINOR_UPGRADE（warning）
       major 不同                        → MAJOR_DIFF    （danger）

2) 配置模型世代轴（与版本轴取并集，取更严重）
   if snapSchema != null && curSchema != null && snapSchema != curSchema:
       code = SCHEMA_ERA_CROSS
       snapSchema > curSchema（新→旧） → danger：旧引擎不识别 cordis.patch.yml，补丁层配置将失效
       snapSchema < curSchema（旧→新） → warning：settings.yaml 一次性导入并改名

3) 官方规则表（单一数据源，复用 version.json#compatibility.rules）
   对 snapVer 按 matchSemverPattern 匹配，按 danger>warning>info 排序取首个命中
   （例：<0.1.5-rc.1 会话存储结构变更；<0.1.7-alpha.1 会话 V4 单向迁移；>=0.2.0 架构重构）
   → bump 到对应 level，message/action 原样透传

4) requiresAcknowledgement = (level ∈ {warning, danger, unknown})
   canProceed = (level != danger) || allowDanger
```

**为什么世代轴要独立于 SemVer**：`0.1.7-alpha.1` 与 `0.1.6-alpha.2` 只差一个 minor，但配置权威模型**完全不同**（§1.2）。仅靠 SemVer 的 `MINOR_UPGRADE` 提示（warning）会低估「新→旧」的致命性（应为 danger）。

### 6.3 当前世代的探测（`detectCurrentSchema`）

```js
function detectCurrentSchema() {
  const v = resolveDshVersion().version;
  if (isValidSemver(v)) return configSchemaForDshVersion(v);   // 版本反推（权威）
  // 版本未知 → 看现网结构
  if (fs.existsSync(path.join(DSH_DIR, 'cordis.patch.yml'))
      || fs.existsSync(path.join(DSH_DIR, 'settings.yaml.imported'))) return 2;
  if (fs.existsSync(path.join(DSH_DIR, 'settings.yaml'))) return 1;
  return null;
}
```

### 6.4 供前端的 API 数据结构

**(a) `GET /api/snapshots`（既有，扩展字段）**

```jsonc
{
  "ok": true,
  "snapshots": [
    {
      "filename": "dsh-snapshot-2026-09-24T16-23-45-123Z-manual.tar.gz",
      "type": "full", "typeLabel": "完整备份",
      "sizeBytes": 538000000, "sizeFormatted": "513.09 MB",
      "createdAt": "2026-09-24T16:23:45.123Z",
      // ↓ 新增
      "dshVersion": "0.1.7-rc.1",
      "dshVersionSource": "package.json",
      "dockerSuiteVersion": "0.1.8",
      "schemaVersion": 2,
      "configModel": "patch-layer",
      "metaSource": "sidecar",          // sidecar|inline|inferred|pending
      "confidence": "high"
    }
  ],
  "activeTask": null
}
```

**(b) `GET /api/snapshots/inspect?file=<filename>`（新增；POST 同构）**

```jsonc
{
  "ok": true,
  "filename": "…tar.gz",
  "meta": { /* §3.2 完整 manifest（或推断结果，带 inference{confidence,signals,dshVersionRange}） */ },
  "metaSource": "inline",               // sidecar|inline|inferred|none
  "confidence": "high",
  "verified": true,                     // manifestSelfHash 校验
  "current": { "dshVersion": "0.1.7-rc.1", "schemaVersion": 2, "configModel": "patch-layer", "dockerSuiteVersion": "0.1.8" },
  "compatibility": {
    "level": "warning",
    "code": "SCHEMA_ERA_CROSS",
    "requiresAcknowledgement": true,
    "canProceed": true,
    "messages": [
      { "level": "warning", "title": "配置模型跨代（旧→新，一次性导入）",
        "message": "快照为 settings-file（1）模型，当前为 patch-layer（2）模型；旧 settings.yaml 会在 DSH 启动时被导入一次并改名为 settings.yaml.imported。",
        "action": "acknowledge" }
    ]
  }
}
```

**(c) `POST /api/snapshots/restore`（既有，扩展请求/响应）**

```jsonc
// 请求
{ "filename": "…tar.gz", "acknowledgeMeta": true, "force": false,
  "expectMeta": { "dshVersion": "0.1.7-rc.1", "schemaVersion": 2 } }  // 可选，TOCTOU 防护
// 响应
{ "ok": true, "filename": "…", "dshReady": true,
  "snapshotVersion": "0.1.7-rc.1",
  "verdict": { "level": "ok", "code": "EXACT_MATCH", "messages": [ /* … */ ] } }
// 失败（需确认）
{ "ok": false, "error": "版本兼容性需要确认: [warning] …", "code": "VERSION_ACK_REQUIRED",
  "verdict": { /* 同 inspect 的 compatibility */ } }   // HTTP 409，便于前端弹窗
```

> 建议 `index.js` 对 `VERSION_ACK_REQUIRED` / `VERSION_DANGER` 返回 **HTTP 409**（而非 500），前端 `restoreSnapshot()`（`admin.html:4546`）据 `data.code` 弹出版本差异卡片后带 `acknowledgeMeta` 重试。

### 6.5 前端呈现建议（`gateway/public/admin.html`）

- 快照表新增「DSH 版本」列：`v0.1.7-rc.1` + 世代徽章（`patch-layer` 蓝 / `settings-file` 灰）+ 来源置信度小图标（`inferred` 显示「推断」）。
- 还原点击后先 `POST /api/snapshots/inspect`（或复用列表已带的字段）：
  - `ok`：普通确认框（现状）。
  - `warning`/`unknown`：黄色卡片列出 `messages`，勾选「我已知悉」后重试。
  - `danger`：复用既有红色强警告卡片样式（`admin.html:2257-2266` 的 `modalIncompatibleDangerWarn`），需输入/勾选强确认后带 `force:true`。

### 6.6 还原后的元数据清理

切换完成后：

```js
try { fs.rmSync(path.join(DSH_DIR, '.dsh-meta'), { recursive: true, force: true }); } catch {}
```

原因：(1) 元数据描述的是**归档**而非 live 配置，留在 live 树会与下次打包注入的 manifest 形成重名成员；(2) 保证 §4.4 的「live 树不含 `.dsh-meta/`」不变量。若要保留「当前配置源自哪个快照」的可观测性，改为写入一个独立的 `/root/.dsh/.last-restore.json`（非 `.dsh-meta/`）即可。

---

## 7. 历史旧快照的向后兼容（无元数据推断）

### 7.1 推断信号（按置信度）

| 置信度 | 判据 | 结论 |
|---|---|---|
| **high** | 存在 `.dsh/cordis.patch.yml` 或 `.dsh/settings.yaml.imported` | 世代 = `2`（patch-layer），`dshVersionRange = >=0.1.7-alpha.1` |
| **high** | 存在 `.dsh/settings.yaml` 且**无** `cordis.patch.yml` | 世代 = `1`（settings-file），`dshVersionRange = <0.1.7-alpha.1` |
| medium | 仅见 `.dsh/profiles/`，无上述任一 | 世代未知，但可判定 `>=0.1.x`（profiles 结构）；标注需人工确认 |
| low | 仅文件名 `dsh-config-*` / `dsh-snapshot-*` | 只推断 `backupType` 与 `createdAt`（文件名时间戳） |

实现见 `inferFromMembers()`（`gateway/snapshot-manifest.js`），实测输出：

```
LEG metaSource= inferred confidence= high schema= 1
    range= <0.1.7-alpha.1
    signals= [ '存在 settings.yaml 且无 cordis.patch.yml（0.1.6 及以前 settings-file 模型）' ]
```

### 7.2 推断结果的使用与落库

- 推断结果写成**同构 manifest**（`dshVersion: null`、`inferred: true`、附 `inference{confidence,signals,dshVersionRange}`），保证 `listBackups` / `assessCompatibility` 只需一套数据结构。
- 立即回填 sidecar（`metaSource: 'inferred'`），**推断只做一次**（`tar -tzf` 是重操作）。
- 判定时：`dshVersion` 缺失 → `UNKNOWN_VERSION`（warning 级，`requiresAcknowledgement: true`），消息里带上推断区间与置信度，让用户自己判断。
- **不建议**把推断出的 `dshVersion` 猜成某个具体值（例如「有 `settings.yaml` 就写 0.1.6」）：推断只能界定**区间**，写死具体版本会制造新的错误权威。宁可显式「未知」。

### 7.3 时间戳兜底

旧文件名 `dsh-snapshot-<ISO-timestamp-sanitized>-<name>.tar.gz` 含创建时间；`listBackups` 在 sidecar 缺失时用 `stat.mtime` 兜底（现有行为），推断时可用文件名解析出更接近真实 `createdAt` 的值。

---

## 8. 代码改动清单（最小侵入）

### 8.1 `gateway/snapshot-manifest.js`（新增，已提供参考实现）

导出：常量、SemVer、`runTarAsync`、`readManifestFromArchive`、`listMembers`、`buildManifest`/`finalizeManifest`/`verifyManifest`、sidecar 读写、`inferFromMembers`、`inspectArchive`、`assessCompatibility`、`stampJsonConfig`/`stampYamlText` 等。

### 8.2 `gateway/backup-service.js`

| 改动 | 位置 |
|---|---|
| `const manifest = require('./snapshot-manifest');` | 顶部 |
| `configure({ getDshVersion })` + `resolveDshVersion()` + `readVersionMeta()` | 新增 |
| `createBackup()`：解析 VersionContext → `buildSnapshotMeta()` → 写 stage → 追加 `-C <stage> .dsh/.dsh-meta/snapshot.json` 为**首个**操作数 → 打包前清理 live `.dsh-meta/` → 转正后写 sidecar（含 `archive.sizeBytes/mtimeMs`） | `:176-279` |
| `listBackups()`：读 sidecar，返回新增字段（保留全部旧字段） | `:593-622` |
| `restoreBackup()`：`validateArchiveMembers` 后 `inspectArchive` + `assessCompatibility` + 门禁（`acknowledgeMeta`/`force`/`expectMeta`）→ 切换后清理 `.dsh/.dsh-meta/`；返回体带 `verdict` | `:284-468` |
| `importBackupStream()`：转正后 `inspectArchive` 回填 sidecar，响应带 `meta`/`compatibility` | `:555-590` |
| `deleteBackup()`：同步删 sidecar | `:624-639` |
| 导出新增 `inspectSnapshot`、`configure` | `:650-662` |

`createBackup()` 关键 diff（示意）：

```js
const versionCtx = {
  ...resolveDshVersion(),
  projectVersion: readProjectVersion(),
  imageRevision: computeImageRevision(),
  compatibilityRange: readVersionMeta()?.compatibility || null,
  contents: sampleContents(DSH_DIR),
  backupType: isConfigOnly ? 'config' : 'full',
  name: safeName
};
const meta = buildSnapshotMeta(versionCtx);

const manifestStage = path.join(SNAPSHOTS_DIR, `.stage-${filename}`);
const stageManifestDir = path.join(manifestStage, '.dsh', '.dsh-meta');
fs.mkdirSync(stageManifestDir, { recursive: true });
fs.writeFileSync(path.join(stageManifestDir, 'snapshot.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });

const tarArgs = [/* 既有 --exclude ... */, '-I', 'pigz', '-cf', tmpPath,
  '-C', manifestStage, '.dsh/.dsh-meta/snapshot.json',   // ← 首个成员
  '-C', '/root', '.dsh'];
// ... 既有 runTarAsync / 转正 ...
writeSidecarAtomic(SNAPSHOTS_DIR, filename, {
  meta, metaSource: 'inline', confidence: 'high', verified: true,
  archive: { sizeBytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) },
  cachedAt: new Date().toISOString()
});
fs.rmSync(manifestStage, { recursive: true, force: true });
```

### 8.3 `gateway/dsh-manager.js`

| 改动 | 位置 |
|---|---|
| 暴露 `getImageRevision()`（把 `:165-169` 的 `IMAGE_REVISION` 提为方法，供 backup-service 复用） | `:162-169` |
| `createSnapshot()`/`restoreSnapshot()` 透传 `opts`（`force`/`acknowledgeMeta`/`expectMeta`） | `:2152-2162` |
| `ensureDefaultSnapshot()` 不受影响（`listBackups` 旧字段保持） | `:2126-2150` |

### 8.4 `gateway/index.js`

| 改动 | 位置 |
|---|---|
| 启动时 `backupService.configure({ getDshVersion: () => dshManager.getCurrentVersion() })` | 启动段（`dshManager.ensureDefaultSnapshot()` 附近 `:1468`） |
| 新增 `GET/POST /api/snapshots/inspect` | `:828` 之后 |
| `/api/snapshots/restore` 透传 `body.acknowledgeMeta/force/expectMeta`；捕获 `VERSION_ACK_REQUIRED`/`VERSION_DANGER` → 409 + verdict | `:802-810` |
| `/api/snapshots/create` 响应带 `snapshot.dshVersion`/`schemaVersion` | `:792-800` |
| `/api/config/save`（`:903`）与 `gateway.config.json` 落盘（`:1431`）前过 `stampJsonConfig()` | `:903`,`:1431` |

---

## 9. 边界条件、安全与失败模式

| 场景 | 处理 |
|---|---|
| manifest 缺失/损坏/JSON 非法 | `readManifestFromArchive` 返回 `null` → 退化结构推断 → 仍无则 `metaSource:'none'`；**不阻断**归档本身 |
| `manifestVersion` 高于本端支持 | 只读已知字段，verdict 附「元数据来自更新套件」提示 |
| 归档损坏（`tar -xzOf` 非 0） | 捕获降级；真正的合法性仍由 `validateArchiveMembers` fail-closed 把关 |
| sidecar 与归档不一致 | `sizeBytes`+`mtimeMs` 双比对失效 → 重新检视并覆盖 sidecar |
| 归档被替换（同名不同内容） | 新鲜度判据触发重检；还原时 `expectMeta` 兜底 TOCTOU |
| 大归档（>300MB）检视耗时 | manifest 在首位 → `--occurrence=1` 命中即停；`runTarAsync` 带超时与输出上限 |
| 并发：列表检视 vs 备份/还原 | 复用 `activeTask` 互斥；懒检视放 `setImmediate` 且不与 `activeTask` 抢 |
| 恶意归档伪造 `dshVersion` 骗过门禁 | 元数据不参与安全判定；解压/切换路径完全由 `validateArchiveMembers` 决定；`manifestSelfHash` 只防误改不防伪造（伪造者本可重算），门禁是**用户体验**层而非安全层 |
| 跨机还原（架构/ABI 不同） | `host{node,platform,arch}` 记录；未来可扩展为「arch 不一致」warning |
| 引擎在线切换后快照版本 ≠ 镜像出厂版本 | 以 `getCurrentVersion()`（运行时）为准，`dshVersionSource` 标注来源 |

---

## 10. 测试计划

**单元（纯函数，`gateway/snapshot-manifest.js`）**
1. `buildManifest` 字段完整性；`schemaVersion` 由 `dshVersion` 反推正确（`0.1.6-alpha.2`→1，`0.1.7-rc.1`→2，`0.1.7-alpha.1`→2 边界）。
2. `finalizeManifest`/`verifyManifest`：篡改任一字段后校验失败。
3. `assessCompatibility` 全矩阵：EXACT / PATCH_DIFF / MINOR_* / MAJOR_DIFF / SCHEMA_ERA_CROSS（双向）/ UNKNOWN_VERSION / 规则命中（`<0.1.7-alpha.1`、`>=0.2.0`）。
4. `inferFromMembers`：四种信号组合 + 置信度。
5. `stampYamlText` 幂等 + `stripYamlStamp` 还原原文；`stampJsonConfig`/`readJsonStamp`。

**集成（真实 tar）**
6. `createBackup` 产物：`tar -tzf` 首成员为 `.dsh/.dsh-meta/snapshot.json`；`validateArchiveMembers` 通过；sidecar 生成。
7. `listBackups` 在 sidecar 存在时不触发任何 tar 调用（可用 `runTarAsync` 打桩计数）；sidecar 删除后能自愈。
8. 还原门禁：构造 danger 快照 → 默认 409 + `VERSION_ACK_REQUIRED`；`acknowledgeMeta:true` 后放行；`force:true` 放行 danger。
9. 旧快照（仅 `settings.yaml`）还原到 0.1.7 系统 → `inferred` + warning + 需确认；反之新→旧 → danger + 阻断。
10. `deleteBackup` 同时清 sidecar。

**回归**
11. `ensureDefaultSnapshot`、导入/下载/创建/还原的既有响应字段不变（前端零改动可运行）。

---

## 11. 兼容性与迁移矩阵

| 快照来源 | 是否含 manifest | 检视结果 | 还原行为 |
|---|---|---|---|
| 新套件（本方案后） | ✅ | `metaSource: inline/sidecar`，版本精确 | 按 verdict 分级提示 |
| 旧套件（本方案前，含 `cordis.patch.yml`） | ❌ | `inferred` high，世代 2，版本区间 `>=0.1.7-alpha.1` | 需确认（未知精确版本） |
| 旧套件（含 `settings.yaml`） | ❌ | `inferred` high，世代 1，区间 `<0.1.7-alpha.1` | 视当前世代定级 |
| 更早（仅 `profiles/`） | ❌ | `inferred` low，世代未知 | 强提示，需确认 |
| 外部导入 | 视来源 | 导入时自动检视并回填 sidecar | 同左 |

**幂等与可回退**：所有新增字段均可空，前端可渐进采用；`manifest` 读取失败一律降级而非报错，因此**移除本功能不会破坏既有快照**。

---

## 12. 风险与取舍

1. **成员顺序依赖**：manifest 依赖「`-C` 交错 + 首个操作数」保证首位。若未来改用别的打包器（如 `bsdtar`），需重新验证顺序语义；`readManifestFromArchive` 本身不依赖顺序（仅性能依赖），功能不受影响。
2. **`.dsh-meta/` 不变量**：需要「打包前清理 + 还原后清理」两处维护。若被绕过（如手工塞入 `.dsh/.dsh-meta/`），会出现重名成员；建议在 `validateArchiveMembers` 之后增加一次「成员去重检测」作为兜底断言（发现重复 manifest 成员即报错）。
3. **sidecar 与归档可能短暂不一致**：以 `sizeBytes+mtimeMs` 判据收敛；极端情况（同大小同 mtime 的内容替换）概率极低，且 `expectMeta` 在还原侧兜底。
4. **推断只给区间**：这是**有意的保守**，避免伪造精确版本造成误导；代价是旧快照一律需要用户确认一次。
5. **不影响安全边界**：本方案**不放宽** `validateArchiveMembers` 的任何一条（元数据在 `.dsh/` 内），也不改变解压/原子切换/回滚路径。

---

## 附录 A：`tar` 行为实测记录

```
# 成员顺序（-C stage ... -C /root ...）
.dsh/.dsh-meta/snapshot.json
.dsh/
.dsh/profiles/
.dsh/profiles/web/package.json
.dsh/cordis.patch.yml

# 快速读取（manifest 在首位）
$ tar -xzOf out.tgz --occurrence=1 .dsh/.dsh-meta/snapshot.json
{"dshVersion":"0.1.7-rc.1","schemaVersion":2}     # exit=0

# 白名单校验放行
$ node -e "require('./gateway/backup-service.js').validateArchiveMembers('out.tgz')…"
VALIDATE OK { members: 5 }

# 反例：全局 --exclude 会把注入的 manifest 一并排除
$ tar --exclude=.dsh/.dsh-meta/snapshot.json -czf out.tgz -C stage … -C live .dsh
tar: .dsh/.dsh-meta/snapshot.json：归档中找不到     # → 不可用 --exclude 去重
```

## 附录 B：参考实现

- [`gateway/snapshot-manifest.js`](../../gateway/snapshot-manifest.js) —— 本设计的可运行参考实现（已在容器内实测：manifest 首成员注入、`--occurrence=1` 读取、sidecar 缓存命中、旧快照推断、兼容判定、JSON/YAML 打戳幂等）。
