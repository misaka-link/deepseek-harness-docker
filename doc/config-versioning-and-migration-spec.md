# DSH 配置文件版本标记与跨版本还原迁移规范（草案 v1.0.0）

> 作者角色：资深配置规范与跨版本兼容专家（AI Agent，deepseek-v4.1-flash）
> 适用对象：`deepseek-harness-docker`（官方 DeepSeek Harness 的 Docker 容器套件与网关）
> 状态：**规范草案**（Design Draft），待评审后落地
> 依据版本：本仓库 `release v0.1.8`（`git log` 最新 `db57c70`），内置官方引擎 `@deepseek-ai/dsh@0.1.7-rc.1`（`version.json:supply.dshVersion = 0.1.7-rc.2`，推荐核心 `compatibility.recommendedDsh = 0.1.7-rc.2`）

---

## 0. 结论摘要（TL;DR）

| 议题 | 结论 |
|---|---|
| YAML 能否加 top-level 版本字段 | **不能**。`cordis.patch.yml` 是**顶层数组**（entry list），`settings.yaml` 是 section→values **映射**且会被 DSH 逐 section 导入；加字段会污染 schema 或被当作 section 尝试导入。→ **YAML 一律用文件头规范注释** |
| JSON 能否加版本字段 | **可以**。`gateway.config.json` 无注释语法，用保留字段 `version` / `dshTargetVersion` / `__meta` |
| 快照的权威版本来源 | **不是**散落的文件内标记，而是归档内 `.dsh/.dsh-version-stamp.json`（单一权威清单，restore 前置读取） |
| 场景 A 同版本 | `COMPATIBLE` → 直接应用 |
| 场景 B 升版还原（0.1.7 还原 0.1.6 快照） | `MIGRATION_REQUIRED` → 由引擎 `importLegacyDocument()` **自动迁移**，但必须防**重复导入回退**（本仓库已踩过该坑） |
| 场景 C 降版还原（0.1.6 还原 0.1.7 快照） | `DOWNGRADE_UNSUPPORTED`（danger）→ **静默丢失全部补丁层配置** + 会话 V4 不可读 → 必须**硬拦截 + 二次确认** |
| 最大风险点 | 场景 C 的"**能启动但配置全丢**"静默失败；以及场景 B 的"**再次还原导致重复导入、回退用户改值**" |

---

## 1. 事实基线与证据链

本规范所有结论均基于对仓库与已安装引擎的**实测**，证据如下（便于评审复核）。

### 1.1 配置层优先级（权威）

`@deepseek-ai/dsh-app-boot` 的 `readProfilePatches()`（`lib/index.js:1015-1025`）逐字实现：

```js
const patches = structuredClone([
    ...profile.layers.flatMap((layer) => layer.patches),                                  // ① 各 bundle 的 patch（按 dsh.profile.bundles 顺序）
    ...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],  // ② profile 自身 cordis.patch.yml
    ...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],        // ③ home 级 $DSH_HOME/cordis.patch.yml
    ...context.overlays                                                                   // ④ --patch CLI 覆盖层（argv 顺序）
]);
```

与官方 `README.zh.md:41-44` 完全一致：

```
配置树以空根为起点，依次叠加以下配置层：
- dsh.profile.bundles 中各组合包的 patch
- profile 自身的 cordis.patch.yml，然后是 home 级的 $DSH_HOME/cordis.patch.yml
- --patch 指定的覆盖层
```

**优先级（低 → 高）**：空根 → bundle patch → **profile patch** → **home patch** → `--patch` overlay →（telemetry 硬禁用 patch，最后 push）。
→ **home 级 patch 高于 profile 级 patch**。这正是本仓库把"容器级预设"写进 home patch 的原因（`CHANGELOG.md:98`）。

### 1.2 `settings.yaml` 的角色变更与一次性导入

引擎侧 `@deepseek-ai/dsh-settings/lib/index.js:343-363`：

```js
async importLegacyDocument() {
    const profile = this.ownerContext.profileContext;
    const path = join(profile.home, "settings.yaml");   // ← 注意：home 根，不是 profiles/web/
    if (!existsSync(path)) return;
    const imported = `${path}.imported`;
    await rename(path, imported);                        // ★ 先改名，再首次写入 → 防重入的关键
    const sections = parse(await readFile(imported, "utf8"));
    for (const [section, values] of Object.entries(sections ?? {})) {
        const ns = LEGACY_SECTION_ENTRIES[section] ?? section;
        try { await this.update(ns, values); }
        catch (error) { /* 被当前组合拒绝 → 只记日志，内容仅留在 .imported */ }
    }
}
```

触发时机：`ctx.root.loader.await().then(() => this.importLegacyDocument())`——即 **Loader 完成全部条目加载后**执行一次。

**防重入机制 = "改名先于写入"**：`settings.yaml` 在第一次写入前就被 `rename` 掉，所以即使导入中途崩溃，下次启动 `existsSync(path)` 为 false，**不会重复导入**。代价是：**被拒绝的 section 永久只留在 `.imported` 里，永不重读**。

Legacy section → entry id 映射（`LEGACY_SECTION_ENTRIES`，`index.js:301-306`）：

| 旧 `settings.yaml` section | 新 entry id |
|---|---|
| `ui-developer-tools` | `ui-settings` |
| `ui-onboarding` | `ui-settings-general` |
| `shell` | `bash-sandbox`（非 win32）/ `pwsh-sandbox`（win32） |
| 其它（`llm-pi-ai`、`ui-theme`…） | 同名 entry id |

实测本机 `/root/.dsh/settings.yaml.imported` 头部即含 `ui-onboarding:` 与 `ui-theme:`，与上表吻合。

### 1.3 现存快照服务的缺口

`gateway/backup-service.js` 实测：

| 行 | 事实 | 对版本化的影响 |
|---|---|---|
| `236` | `tar -cf tmpPath -C /root .dsh`（成员全部在 `.dsh/` 下） | 版本清单必须放在 `.dsh/` 内 |
| `217` | **排除** `gateway.config.json` | 网关权威配置**不进快照**，restore 时从现网携带（`354`） |
| `354` | restore 从现网 copy 回 `gateway.config.json`、`.session_secret` | 意味着网关配置跨版本还原时**不随快照走**，需单独治理 |
| `120-169` | `validateArchiveMembers()` 只允许 `.dsh/` 下成员 | 归档根放清单会被拒；须放 `.dsh/` 内 |
| `176-279` | `createBackup()` **不写任何版本清单** | ← 需求 1 缺口 |
| `284-468` | `restoreBackup()` **不做任何版本判定** | ← 需求 2 缺口 |
| `396-406` | `node_modules` 空则 `pnpm install --no-frozen-lockfile` | 跨版本会拉到与目标 DSH peer 不符的插件版本 |

### 1.4 既有兼容性矩阵（可复用，避免重复造轮子）

`version.json:compatibility`：

```json
{
  "recommendedDsh": "0.1.7-rc.2",
  "supportedDshRange": ">=0.1.2-rc.1 <=0.1.7-rc.2",
  "adaptedVersions": ["0.1.7-rc.2","0.1.7-rc.1","0.1.7-alpha.2","0.1.7-alpha.1","0.1.6-alpha.2","0.1.6-alpha.1","0.1.5-rc.2","0.1.5-rc.1","0.1.2-rc.1"],
  "rules": [
    { "pattern": "<0.1.5-rc.1",     "level": "warning", "title": "向后降级格式风险", ... },
    { "pattern": "<0.1.7-alpha.1",  "level": "warning", "title": "会话格式 V4 降级风险", ... },
    { "pattern": ">=0.2.0",         "level": "danger",  "title": "底层协议重大重构", "action": "force-docker-pull" }
  ]
}
```

`gateway/version-service.js` 已提供 `parseSemver` / `isSemver` / `compareSemver` / `matchSemverPattern`（支持 `>=` `>` `<=` `<` `=`）与 `evaluateTargetVersion()`。
`scripts/version-matrix-sync-test.mjs` 已确立"**单一数据源**"纪律（`version.json` 为源，`dsh-manager.js` / `version-service.js` / `admin.html` 为同步副本）。
→ 本规范**必须**接入该矩阵，而非另立一套。

### 1.5 实测发现的关键实现约束（本规范必须补齐）

> 以下两点经**实机验证**，是落地时最容易踩的坑。

**缺口 ①：`matchSemverPattern` 无法求值复合区间 `supportedDshRange`。**

`version.json` 的 `supportedDshRange = ">=0.1.2-rc.1 <=0.1.7-rc.2"` 是**空格分隔的 AND 复合表达式**，但现有 `matchSemverPattern` 只识别**单个**前导操作符：

```js
if (p.startsWith('>=')) return compareSemver(ver, p.slice(2).trim()) >= 0;  // p = "0.1.2-rc.1 <=0.1.7-rc.2"
//                                            ↑ 剩余部分被当版本号解析 → parseSemver 静默降级为 0.1.2
```

实测：`matchSemverPattern('0.2.0', '>=0.1.2-rc.1 <=0.1.7-rc.2')` 返回 **`true`**（应为 `false`）——即 **0.2.0 会被误判为"在支持区间内"**。
现有代码因此**只把该字段用于展示**（`patch-dsh-client.mjs:40-51` 仅 `console.log` 打印，从不判定；`admin.html` 仅渲染），从未程序化求值。
→ **规范要求新增 `satisfiesRange(version, range)`**：按空白拆分为多个 term，**逐 term AND**。实测修正后 `0.1.7-rc.2` IN、`0.1.7-rc.3` / `0.1.8` / `0.2.0` OUT，全部正确。

**缺口 ②：`version-service.js` 导出的是单例，不是工具函数。**

文件末尾为 `module.exports = new VersionService();`——`parseSemver` / `compareSemver` / `matchSemverPattern` / `isSemver` **均未导出**，新模块无法 `require` 复用。
→ **规范要求**：将上述纯函数（含新增 `satisfiesRange`）改为**具名导出**（可同时保留默认单例导出，向后兼容），并新增 `scripts/version-matrix-sync-test.mjs` 断言防止再次漂移。

**缺口 ③：`status` 判定必须用 `satisfiesRange`，不能用 `matchSemverPattern`。**
否则场景 C（0.2.0 阻断）会被静默放行为 `COMPATIBLE`——实测复现。

---

## 2. 核心配置文件版本演进剖析

### 2.1 0.1.5 / 0.1.6 与 0.1.7 / 0.1.8 差异总表

| 配置面 | 0.1.5 / 0.1.6（legacy） | 0.1.7 / 0.1.8（patch-layer） | 兼容性判定 |
|---|---|---|---|
| **权威存储** | `$DSH_HOME/settings.yaml`（section→values 映射） | `cordis.patch.yml`（profile + home 两级 entry-list 数组） | 布局变更，**不兼容** |
| **`settings.yaml` 角色** | 权威，每次启动读写 | **一次性导入源**，首次写入前改名 `settings.yaml.imported`，此后只读不写 | 单向、不可逆 |
| **patch 层** | 不存在（Loader 不读该文件） | profile `profiles/web/cordis.patch.yml` + home `$DSH_HOME/cordis.patch.yml` | 旧版**完全不认识** |
| **优先级** | settings.yaml 单一层 | bundle → profile patch → **home patch** → `--patch` | 新增 3 层 |
| **`gateway.config.json`** | 有（无版本字段） | 有（**仍无版本字段**） | 需补标 |
| **`plugins-state.json`** | `disabled`/`uninstalled`/`known` | 同结构 + 原生 plugin-manager 参与写入、profile 写锁 | 结构兼容，**语义风险** |
| **`profiles/web/package.json`** | `dependencies`（无/少 `dsh.profile`） | `dependencies` + `dsh.profile.bundles[]` + `patchReload` | 新增 manifest 字段 |
| **会话格式** | V3 | **V4（单向迁移）** | 降版不可读 |
| **配置写入方** | 套件脚本 | 套件脚本 + 官方 plugin-manager + settings 编辑器（共享 `package.json.lock`） | 并发风险 |

### 2.2 `settings.yaml` 角色变更（旧版权威 → 新版一次性导入）

```
0.1.6 世界                                0.1.7 世界
┌───────────────────────┐                 ┌──────────────────────────────────────┐
│ $DSH_HOME/settings.yaml│  ← 权威        │ $DSH_HOME/cordis.patch.yml  ← home 层  │
│  ui-onboarding:       │  每次读写      │   - id: ui-settings-general           │
│  llm-pi-ai:           │                │     config: { welcomeNoticeVersion }  │
│  ui-theme:            │                ├──────────────────────────────────────┤
└───────────────────────┘                │ profiles/web/cordis.patch.yml ← profile│
                                          │   - id: llm-pi-ai                     │
        ── 升级到 0.1.7 ──►               │     config: { providers: {...} }      │
                                          ├──────────────────────────────────────┤
启动后 Loader settle → importLegacyDocument()│ $DSH_HOME/settings.yaml.imported ← 只读│
  rename(settings.yaml → settings.yaml.imported)│  （历史遗留，被拒绝的 section 只留这）│
  for each section: update(mappedId, values)  └──────────────────────────────────────┘
```

**要点**：
1. `rename` **先于**首次写入 → 幂等性靠"文件不存在"实现，而非状态位。
2. 导入目标写入的是**当前 profile 的配置**（`this.update`），不是重写 `cordis.patch.yml` 字面文本——但最终落盘位置由 config-editor 决定，实测表现为 profile/home patch。
3. 被拒绝的 section **只在 `.imported`**，需要人工搬运。

### 2.3 `cordis.patch.yml`（Home 级 vs Web Profile 级）

**结构**：顶层 **YAML 数组**（entry-list / patch-list），每项形如 `{ id, name?, config?, disabled? }`；支持 `!!js` 表达式。**空层写作 `[]`**（实测 `profiles/web/cordis.yml` 就是 `[]`，注释明确："Edit cordis.patch.yml, not this file"）。

**两级分工（本仓库实测）**：

```yaml
# ① $DSH_HOME/cordis.patch.yml —— 容器级 / 全 profile 生效 / 优先级最高
- id: ui-sidebar-browser
  disabled: false
- id: dsh-market
  config: { allowRestart: false }
```
```yaml
# ② ~/.dsh/profiles/web/cordis.patch.yml —— profile 级 / 用户配置 / 官方设置页与插件管理器会改写它
- id: better-sidebar
  disabled: true
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers: { newapi: { ... } }
- id: agent-default-model
  config: { provider: newapi, model: gemini-3.8-flash, reasoningEffort: high }
```

**规范结论（重要）**：
- **home patch = 套件权威、低易变、容器级预设**（不会被官方设置页/插件启停改写 → 应承载版本标记与容器预设）。
- **profile patch = 用户易变层**（官方会外科手术式改写 → 版本注释头必须由"统一写入函数"维护，见 §3.1.3）。
- 层级越高越"重"：`--patch` overlay 最高，仅用于一次性诊断/应急，**不得**作为持久化载体。

### 2.4 `gateway.config.json`（网关权威配置）的版本标记

实测当前内容**无任何版本字段**：

```json
{ "proxyPort": 18848, "adminPath": "/admin", "vncPath": "/vnc", "authToken": "misakanet",
  "autoHealPlugins": true, "autoHealMaxPerBoot": 5, "desktop": { ... }, "savedAt": "..." }
```

且它**被排除出快照**（`backup-service.js:217`），restore 时从现网携带（`:354`）。
→ 版本标记的价值在于：**跨机迁移 / 导入导出 / 未来若要把它纳入快照**时，能判断其字段语义属于哪一代 DSH。
→ 采用 JSON 保留字段方案（§3.2）。

### 2.5 `plugins-state.json` 与 `profiles/web/package.json`

```json
// plugins-state.json —— 结构跨版本稳定，但"版本语义"脆弱
{ "disabled": ["@dsh-custom/dsh-settings-config-path", "dsh-client-auto-continue"],
  "uninstalled": [], "known": [...], "updatedAt": "2026-09-22T19:14:03.704Z" }
```

```json
// profiles/web/package.json —— 新增 dsh.profile 清单，是跨版本最大的"硬约束"
{ "dependencies": { "dsh-archived-chats": "^1.4.2", "dshmarket": "link:/usr/local/lib/node_modules/dshmarket", ... },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@dsh-custom/dsh-browser-desktop","dshmarket","@hytime/dsh-thinking-effort","@deepseek-ai/dsh-experimental-agent-team-profile","dsh-archived-chats"],
                        "patchReload": "live" } } }
```

**风险点**：
- `bundles[]` 引用的组合包若在目标 DSH 版本不存在 → **启动失败**。
- 插件对 `dsh` 的 peer 范围校验（官方 `README.zh.md:39`："安装和 profile 启动会按声明的 DSH peer 范围，检查与 `dsh --version` 显示值相同的运行时版本"）→ 跨版本可能拒绝启动，需 `version-exemptions`。
- `^1.4.2` 这类 caret 范围在 `pnpm install --no-frozen-lockfile` 下会解析到**与目标 DSH 不符**的新版本。

→ 规范：**这两者必须纳入版本标记的"依赖指纹"**，并在 restore 前做**差异预检**（§5.3）。

---

## 3. 配置文件内部版本标记（In-File Version Tagging）方案

### 3.1 YAML 文件（`cordis.patch.yml`、`settings.yaml`）

#### 3.1.1 为什么不用 top-level 字段

| 候选 | 对 `cordis.patch.yml` | 对 `settings.yaml` | 判定 |
|---|---|---|---|
| `__schema_version: "1.0.0"` top-level | **破坏 schema**：顶层必须是数组，对象会导致 Loader 解析/校验失败 | **被当 section 导入**：`Object.entries` 会得到 `__schema_version` → `update("__schema_version", ...)` 抛错 → 记 warn，脏日志 | ❌ |
| `# @dsh-version:` 注释头 | YAML 解析**完全忽略**注释 | 同左 | ✅ |
| 文件名编码 | 破坏 DSH 对固定文件名的硬编码查找 | 同左 | ❌ |

→ **YAML 一律采用"文件头规范注释块"（canonical comment header）**。

#### 3.1.2 规范注释头格式（RFC 2119 语气）

```yaml
# ===== DSH CONFIG VERSION STAMP — DO NOT REMOVE =====
# @dsh-version: 0.1.7-rc.1
# @dsh-range: >=0.1.7-alpha.1 <=0.1.7-rc.2
# @schema-version: 1.0.0
# @layout: patch-layer
# @producer: deepseek-harness-docker@0.1.8
# @tagged-at: 2026-09-25T00:00:00.000Z
# @stamp-id: 8f3c1a2e-...
# ====================================================
```

约束：
- **MUST** 位于文件**第 1 行起**（注释块之前不得有其它内容）；
- 字段名 **MUST** 使用 `@kebab-case`，值 **MUST** 为单行标量；
- 解析器 **MUST** 只读取 `^#\s*@([a-z0-9-]+):\s*(.+)$`，忽略其余注释（保证向后兼容：老文件无注释头 → 返回 `null`，不报错）；
- `@stamp-id` 为 ULID/UUID，用于**快照去重与来源追溯**；
- 该注释块 **MUST NOT** 影响 patch 语义——实测 Loader 用 `js-yaml` 解析，注释天然被丢弃。

#### 3.1.3 与"外科手术式改写"的兼容（关键工程约束）

`CHANGELOG.md:105` 已确立：`cordis.patch.yml` 的清理是**字符区间外科手术式改写**（"只删除命中条目的字符区间，其余字节逐字保留"），并有安全闸。
因此规范要求：

1. 所有写入方 **MUST** 统一走 `writePatchFile()`（新增于 `gateway/`），职责：
   - 读取 → 剥离旧 stamp 头 → 业务改写（区间替换） → **重新注入 stamp 头** → 原子写（`tmp` + `rename`）；
2. `writePatchFile()` **MUST** 在写入时刷新 `@dsh-version` = **当前运行版本**、`@tagged-at` = now；
3. **MUST** 保留"安全闸"：若改写会丢失非目标条目（如 `llm-pi-ai`）→ 放弃写入并告警；
4. 任何直接 `fs.writeFileSync('cordis.patch.yml')` 的旧代码 **MUST** 迁移到 `writePatchFile()`（可作为 lint 规则/回归测试项）。

#### 3.1.4 `settings.yaml` 的特殊处理

`settings.yaml` 在新版 DSH 中是**只读历史文件**（`.imported`），套件 **MUST NOT** 再写入它。因此：
- 对**快照内的** `settings.yaml` / `settings.yaml.imported`：注入**只读注释头**（仅供还原时判版），标记 `@layout: legacy-settings`；
- 对**现网**：若发现 `settings.yaml` 存在（说明尚未迁移），网关 **MUST** 告警并记录，**MUST NOT** 主动删除或改名（改名权属于引擎的一次性导入）。

### 3.2 JSON 文件（`gateway.config.json` 等）

#### 3.2.1 字段设计

```jsonc
{
  "version": 1,                                  // ★ 网关配置 schema 版本（整数，破坏性变更时 +1）
  "dshTargetVersion": "0.1.7-rc.1",              // ★ 生成该配置时所针对的 DSH 版本
  "__meta": {                                    // ★ 保留命名空间（双下划线，避免与业务键冲突）
    "stampVersion": 1,
    "schemaVersion": "1.0.0",
    "dshTargetVersion": "0.1.7-rc.1",
    "dshTargetRange": ">=0.1.7-alpha.1 <=0.1.7-rc.2",
    "layout": "patch-layer",
    "producer": "deepseek-harness-docker@0.1.8",
    "stampId": "8f3c1a2e-...",
    "taggedAt": "2026-09-25T00:00:00.000Z"
  },
  "proxyPort": 18848,
  "adminPath": "/admin",
  "desktop": { "...": "..." },
  "savedAt": "2026-09-22T18:23:00.262Z"
}
```

设计理由：
- `version`（整数）+ `dshTargetVersion`（字符串）**扁平**暴露，便于 `grep`/`jq` 与快速判版；
- `__meta` 承载**完整 Version Stamp**（§4），供机器读取；
- 读取方 **MUST** 容忍字段缺失（老配置无版本字段 → 视为 `version: 0` / `UNKNOWN_VERSION`）；
- 写入方 **MUST NOT** 删除未知字段（前向兼容：新版本写的字段，老版本读后回写不应丢）。

#### 3.2.2 `plugins-state.json` / `profiles/web/package.json` 的标记

这两个文件的 schema 由**官方**控制（plugin-manager 会改写），**不得**插入自定义顶层字段（会被官方整文件读-改-写丢弃）。
→ 对其采用**旁路标记**：不写在文件内，而是写进**快照清单**的 `fingerprint` 段（§4.1），记录其哈希与解析出的版本信息。

```jsonc
// 快照清单 .dsh/.dsh-version-stamp.json 中的 fingerprint 段
"fingerprint": {
  "pluginsState": { "sha256": "...", "disabledCount": 2, "knownCount": 9 },
  "webProfile":   { "sha256": "...", "bundles": ["@deepseek-ai/dsh-base", "..."],
                    "pluginPins": { "dsh-archived-chats": "^1.4.2", "dshmarket": "link:..." } },
  "homePatchSha": "...", "profilePatchSha": "..."
}
```

---

## 4. 快照版本清单（Snapshot Version Stamp）——单一权威

> 需求 1："创建配置文件与备份快照时，文件必须标记 DSH 版本信息"。
> 需求 2："恢复备份时，必须能检测、提取并提示适用版本"。

**设计原则**：文件内标记（§3）用于**单文件溯源**；快照清单用于**还原判定**。两者字段同构（同一 `VersionStamp` 形状），避免"两套真相"。

### 4.1 清单位置与格式

**位置**：`$DSH_HOME/.dsh-version-stamp.json` → 归档成员 `.dsh/.dsh-version-stamp.json`
（**必须**在 `.dsh/` 内，否则被 `validateArchiveMembers()` 拒绝，见 `backup-service.js:142-144`）。

**格式**：

```jsonc
{
  "stampVersion": 1,
  "schemaVersion": "1.0.0",
  "kind": "snapshot",                       // snapshot | home | file
  "stampId": "8f3c1a2e-1b2c-4d5e-9f01-23456789abcd",
  "producer": "deepseek-harness-docker@0.1.8",
  "taggedAt": "2026-09-25T00:00:00.000Z",

  "dshTargetVersion": "0.1.6-alpha.2",       // ★ 生成快照时的运行版本
  "dshTargetRange": ">=0.1.2-rc.1 <=0.1.6-alpha.2",
  "layout": "legacy-settings",               // ★ legacy-settings | patch-layer | hybrid | unknown
  "layoutMinDsh": "0.1.2-rc.1",              // 该布局最早被哪个 DSH 理解
  "layoutMaxDsh": "0.1.6-alpha.2",           // 该布局最晚被哪个 DSH 原生支持（null = 仍支持）

  "snapshot": { "name": "pre-upgrade", "type": "full", "createdAt": "..." },
  "migrationState": { "migrated": false, "migratedAt": null, "migratedBy": null,
                      "sectionsImported": [], "sectionsRejected": [] },
  "fingerprint": { "...": "见 §3.2.2" },
  "files": [                                  // 逐文件内标记汇总（供单文件级溯源）
    { "path": ".dsh/cordis.patch.yml", "stamp": { "@dsh-version": "0.1.6-alpha.2", "@schema-version": "1.0.0" } },
    { "path": ".dsh/settings.yaml",    "stamp": { "@dsh-version": "0.1.6-alpha.2", "@layout": "legacy-settings" } }
  ]
}
```

### 4.2 备份时写入流程（改造 `createBackup`）

```
createBackup(name, type)
  ├─ 1. 采集运行版本 currentDsh = dshManager.getCurrentVersion()          // backup-service.js 已有依赖可注入
  ├─ 2. 探测布局 layout = detectLayout(DSH_DIR)                            // 见 §4.3
  ├─ 3. 对参与快照的每个 YAML/JSON 配置文件：injectStamp(file, stamp)      // 见 §3，就地刷新注释头/字段
  ├─ 4. 计算 fingerprint（patch/plugins-state/package.json 的 sha256 + bundles + pins）
  ├─ 5. 原子写 DSH_DIR/.dsh-version-stamp.json
  ├─ 6. tar -cf tmp -C /root .dsh   （清单天然被包含）
  ├─ 7. rename(tmp → final)   （保持现有原子转正语义）
  └─ 8. 返回 snapshot 元数据时**附带 stamp**（供 Admin 列表直接显示"适用版本"）
```

> ⚠️ 幂等性：第 3 步是"就地刷新"，因此同一 home 反复备份不会累积注释头（`writePatchFile` 先剥离后注入）。

### 4.3 布局探测（`detectLayout`）——兼容"无清单老快照"

```js
function detectLayout(dshDir) {
  const has = (p) => fs.existsSync(path.join(dshDir, p));
  const hasPatch  = has('cordis.patch.yml') || has('profiles/web/cordis.patch.yml');
  const hasLegacy = has('settings.yaml');
  const hasImport = has('settings.yaml.imported');
  if (hasPatch && hasLegacy)  return 'hybrid';          // ★ 过渡态/异常态，需人工判定
  if (hasPatch)               return 'patch-layer';
  if (hasLegacy || hasImport) return 'legacy-settings'; // .imported 也说明曾走 legacy
  return 'unknown';
}
```

### 4.4 还原时提取流程（改造 `restoreBackup`）

```
restoreBackup(filename)
  ├─ 0. validateArchiveMembers()                                    // 保留现有安全校验
  ├─ 1. 只抽取清单（不解压全量）：
  │      tar -xOzf <archive> .dsh/.dsh-version-stamp.json
  │      ├─ 命中 → stamp
  │      └─ 未命中（老快照）→ stamp = synthesizeFromLayout()  // tar -tzf 探测布局，构造最小 stamp
  ├─ 2. 版本判定：verdict = evaluateRestoreCompatibility(stamp, currentDsh, matrix)   // §5
  ├─ 3. 分支：
  │      ├─ COMPATIBLE*              → 继续
  │      ├─ MIGRATION_REQUIRED       → 返回预览（含迁移计划）→ 等待显式确认 → 继续
  │      ├─ DOWNGRADE_UNSUPPORTED    → 硬拦截（除非 force + 二次确认）→ 见 §6.3
  │      └─ BLOCKED_INCOMPATIBLE     → 拒绝
  ├─ 4. 现有 staging → 原子切换 → 权限自愈
  ├─ 5. 【新增】迁移后处理：
  │      ├─ 重新注入 home 级容器预设到 $DSH_HOME/cordis.patch.yml   // 快照切换会整体覆盖 home
  │      ├─ 预检 bundles/pins 差异 → 必要时 pnpm install
  │      └─ 写 migrationState 到 stamp + 刷新 .dsh-version-stamp.json（打上**当前**版本）
  ├─ 6. boot() 并验证就绪
  └─ 7. 【新增】扫描 settings.yaml.imported，把"被拒绝的 section"回传前端提示
```

---

## 5. 跨版本还原的智能迁移与兼容策略

### 5.1 兼容性状态枚举（Status Enum）

统一命名空间 `DSH_RESTORE_STATUS`，与既有 `rule.level` 对齐：

| 枚举 | 语义 | 默认动作 | 映射 `level` |
|---|---|---|---|
| `COMPATIBLE` | 完全兼容（同版本、同布局） | 直接应用 | `ok` |
| `COMPATIBLE_WITH_NOTICE` | 兼容但有提示（同 minor 不同 patch/预发布） | 应用 + 提示 | `info` |
| `MIGRATION_REQUIRED` | 需升版迁移（旧布局 → 新版，可自动） | 预览 + 确认后自动迁移 | `warning` |
| `MIGRATION_REQUIRED_STRICT` | 需人工介入迁移（布局 `hybrid`，或有 rejected sections / bundles 大差异） | 阻断，要求人工确认迁移计划 | `warning` |
| `DOWNGRADE_UNSUPPORTED` | 降版不支持（新布局 → 旧版，旧版不识别 patch） | **硬拦截**，需 force + 二次确认 | `danger` |
| `RISK_WARNING` | 跨版本潜在风险（会话 V4、插件 peer、schema 漂移） | 可应用，但需强提示 + 建议数据卷回滚 | `warning` |
| `BLOCKED_INCOMPATIBLE` | 超出支持区间（如 ≥0.2.0） | 拒绝，提示重新拉镜像 | `danger` |
| `UNKNOWN_VERSION` | 快照无版本标记（老套件产物） | 按布局推断 + 强制人工确认 | `warning` |

### 5.2 判定算法

```js
/**
 * @param {object} stamp        快照版本清单（可能来自 synthesizeFromLayout）
 * @param {string} currentDsh   当前运行 DSH 版本（dshManager.getCurrentVersion()）
 * @param {object} matrix       version.json:compatibility（含 supportedDshRange / rules / adaptedVersions）
 */
function evaluateRestoreCompatibility(stamp, currentDsh, matrix) {
  const notes = [], blocks = [];

  // ① 版本合法性
  if (!isSemver(currentDsh)) return { status: 'BLOCKED_INCOMPATIBLE', reason: '当前 DSH 版本号非法' };

  // ② 无标记 → 老快照
  if (!stamp || !stamp.dshTargetVersion) {
    if (stamp?.layout === 'legacy-settings')
      return { status: 'UNKNOWN_VERSION', level: 'warning',
               reason: '快照无版本标记，按 legacy-settings 布局推断（疑似 0.1.6 及更早）',
               needsConfirm: true, notes };
    return { status: 'UNKNOWN_VERSION', level: 'warning', needsConfirm: true, notes };
  }

  const snapVer  = stamp.dshTargetVersion;
  const snapLay  = stamp.layout;
  const cmp      = compareSemver(snapVer, currentDsh);          // >0 快照更新，<0 快照更旧

  // ③ 硬阻断：超出支持区间
  //    ★ 必须用 satisfiesRange（复合 AND 区间）；用 matchSemverPattern 会把 0.2.0 误判为在区间内（见 §1.5 缺口①）
  if (!satisfiesRange(currentDsh, matrix.supportedDshRange))
    return { status: 'BLOCKED_INCOMPATIBLE', level: 'danger',
             reason: `当前 DSH ${currentDsh} 不在支持区间 ${matrix.supportedDshRange}` };

  // ④ 降版：新布局（patch-layer）→ 旧版 DSH
  if (cmp > 0) {
    const oldDshUnderstandsPatch = matchSemverPattern(currentDsh, '>=0.1.7-alpha.1');
    if (snapLay === 'patch-layer' && !oldDshUnderstandsPatch) {
      return { status: 'DOWNGRADE_UNSUPPORTED', level: 'danger', needsForce: true,
        reason: '快照为 0.1.7+ 补丁层布局，当前旧版 DSH 不读取 cordis.patch.yml：' +
                '将静默丢失全部补丁层配置（模型/provider/插件启停/主题），且 0.1.7 的 V4 会话不可读。',
        notes: ['建议改为还原到同版本 DSH，或重新拉取目标版本的 Docker 镜像'] };
    }
    // 旧布局 → 新版（升版）：走迁移
    if (snapLay === 'legacy-settings')
      return { status: 'MIGRATION_REQUIRED', level: 'warning', needsConfirm: true,
               plan: buildMigrationPlan(stamp, currentDsh), notes };
    return { status: 'RISK_WARNING', level: 'warning', notes };
  }

  // ⑤ 同版本
  if (cmp === 0) {
    if (snapLay === 'hybrid')
      return { status: 'MIGRATION_REQUIRED_STRICT', level: 'warning', needsConfirm: true,
               reason: '快照同时含 settings.yaml 与 cordis.patch.yml（过渡态），需人工确认', notes };
    if (snapLay === 'legacy-settings' && matchSemverPattern(currentDsh, '>=0.1.7-alpha.1'))
      return { status: 'MIGRATION_REQUIRED', level: 'warning', needsConfirm: true,
               plan: buildMigrationPlan(stamp, currentDsh), notes };
    return { status: 'COMPATIBLE', level: 'ok', notes };
  }

  // ⑥ 快照更旧（升版还原）
  if (snapLay === 'legacy-settings' && matchSemverPattern(currentDsh, '>=0.1.7-alpha.1')) {
    // 叠加既有矩阵规则（会话 V4 / 会话结构）
    const extra = matchRules(snapVer, currentDsh, matrix.rules);
    return { status: 'MIGRATION_REQUIRED', level: 'warning', needsConfirm: true,
             plan: buildMigrationPlan(stamp, currentDsh), notes: [...notes, ...extra] };
  }
  if (snapLay === 'patch-layer')
    return { status: 'COMPATIBLE_WITH_NOTICE', level: 'info',
             reason: `同布局跨版本（${snapVer} → ${currentDsh}）`, notes };
  return { status: 'RISK_WARNING', level: 'warning', notes };
}
```

> 实现上 `matchRules` 复用现有 `version-service.evaluateTargetVersion` 的规则匹配逻辑（`sort by severity` + `matchSemverPattern`），避免第二套规则引擎。

### 5.3 场景逐一剖析

#### 场景 A：同版本（0.1.7 → 0.1.7）

- 判定：`COMPATIBLE`。
- 动作：沿用现有 `restoreBackup` 流程（staging → 原子切换 → 权限自愈 → boot）。
- 新增：校验 `stamp.schemaVersion` 是否被本网关支持；把清单里的 `stamp` 回显到 Admin 列表（"适用版本 0.1.7-rc.1"）。
- 注意：即便同版本，若快照含 `settings.yaml`（0.1.6 时代的 home 被 0.1.7 运行），仍会触发一次性导入 → 归入场景 B。

#### 场景 B：升版还原（当前 0.1.7 还原 0.1.6 快照）

快照特征：含 `settings.yaml`，**无** `cordis.patch.yml`。

**如何让新版 DSH 自动触发迁移**：无需额外触发——引擎在 boot 时 `ctx.root.loader.await().then(() => importLegacyDocument())` 自动执行。网关只需：
1. 还原前给出 `MIGRATION_REQUIRED` 预览；
2. 还原后**不**再写入 `settings.yaml`（历史上套件脚本"每次重启重建 settings.yaml"正是回退 bug 的根因，`CHANGELOG.md:98`，现已删除——**规范要求永久禁止该行为**）；
3. 迁移完成后写 `migrationState` 并**刷新 stamp 为当前版本**。

**防重入陷阱（必须遵守）**：

| 陷阱 | 后果 | 规范对策 |
|---|---|---|
| **T1 重复还原同一 legacy 快照** | 快照里 `settings.yaml` 仍在 → 每次还原都重跑导入 → 覆盖用户在设置页改过的新值（**值回退**） | restore 成功后，在 stamp 内写 `migrationState.migrated=true`；再次还原同一快照时提示"该快照含 legacy settings.yaml，将再次导入并可能回退已修改的值"；Admin 列表对该类快照打 **`已迁移`** 徽标 |
| **T2 半迁移快照（`hybrid`）** | 同时含 `settings.yaml` 与 `settings.yaml.imported` → 引擎 `rename` 会**覆盖**已有 `.imported`，丢失其中"被拒绝的 section" | 判定 `MIGRATION_REQUIRED_STRICT`，**强制人工确认**；还原前把快照内 `.imported` 另存备份 |
| **T3 导入被拒 section 静默丢失** | 被当前组合拒绝的 section 只留在 `.imported`，永不重读 | 还原后**扫描 `.imported`** 并与导入结果比对，把"未导入 section 列表"回传前端强提示 |
| **T4 home patch 被整体覆盖** | 快照切换是"逐子项搬移"（`backup-service.js:362-368`），home 目录被 0.1.6 内容替换 → 0.1.7 的容器级 home patch 预设**丢失** | 切换后**重新注入** home 级容器预设（版本标记 + 容器级配置），再 boot |
| **T5 迁移在 boot 中失败** | 导入抛错（如某 section schema 不符）→ 现有代码会走回滚（`:444-459`），但回滚后 home 又变回"含 settings.yaml"的旧态 | 迁移失败**不得**视为 restore 失败而盲目回滚；应区分"迁移告警"与"启动失败"，仅后者回滚 |
| **T6 `profile.home` 定位** | 引擎读的是 `join(profile.home, "settings.yaml")`；实测 home = `$DSH_HOME`（非 `profiles/web/`） | 版本标记与迁移检测**必须**以 `$DSH_HOME` 为基准，不得假设在 profile 子目录 |

#### 场景 C：降版还原（当前 0.1.6 还原 0.1.7 快照）

快照特征：含 `cordis.patch.yml`（home 与/或 profile），**无** `settings.yaml`。

**严重后果（按严重度）**：

1. **静默配置全丢**（最危险）：0.1.6 的 Loader **根本不读** `cordis.patch.yml` → 系统"正常启动"，但
   - 自定义模型 / provider（`llm-pi-ai`）、默认模型（`agent-default-model`）、主题、插件启停、UI 设置 **全部回落到 bundle 默认值**；
   - 用户会以为"还原成功"，实际配置已空。**这是无报错的静默数据损失**。
2. **会话不可读**：0.1.7 会话为 V4 单向格式，0.1.6 无法解析（`version.json` 规则 `<0.1.7-alpha.1`）。
3. **插件状态错乱**：`plugins-state.json` 的 `known`/`disabled` 引用了 0.1.6 不存在的插件；`profiles/web/package.json` 的 `bundles[]` 含 0.1.7 组合包 → **启动失败**。
4. **二次污染**：旧版 DSH 启动后会以**旧格式**回写 `plugins-state.json` / `package.json`，甚至新建 `settings.yaml`；等到再切回 0.1.7 时，新格式信息已丢失、且多出一个 legacy `settings.yaml` → 触发意外导入。
5. **不可逆**：以上叠加后，仅靠快照已难以恢复（需要连同**数据卷快照**一起回滚）。

**如何拦截并强警告**：

- 判定为 `DOWNGRADE_UNSUPPORTED`（`level: danger`）→ **默认拒绝**；
- 拦截文案必须**具体列出**将丢失的配置类别（从 `fingerprint` 读实际条目，而非泛泛而谈）：
  > "该快照由 DSH **0.1.7-rc.1** 生成，使用**补丁层**布局；当前运行 **0.1.6-alpha.2** 不读取 `cordis.patch.yml`。继续将**静默丢失**：模型/provider（1 个 provider / 12 个模型）、默认模型、主题、插件启停（2 项停用 / 9 项已知）、UI 设置；且 0.1.7 的 V4 会话不可读。"
- 需**二次确认**：输入快照适用版本号（如 `0.1.7-rc.1`）方可强制继续（`force: true`），并**强制自动创建还原前快照**；
- 推荐路径：还原到**同版本** DSH，或按目标版本**重新拉取 Docker 镜像**（对齐现有 `action: force-docker-pull` 约定）。

### 5.4 数据流图解

```
【备份时 —— 标记】
  ┌──────────────┐   getCurrentVersion()   ┌────────────────────┐
  │ dsh-manager  │ ──────────────────────► │  createBackup()    │
  └──────────────┘                         └─────────┬──────────┘
                                                     │ ① detectLayout()
                                                     │ ② injectStamp()  → cordis.patch.yml / settings.yaml（注释头）
                                                     │                    gateway.config.json（version/dshTargetVersion/__meta）
                                                     │ ③ fingerprint()  → patch/plugins-state/package.json 哈希+bundles+pins
                                                     │ ④ 原子写 .dsh/.dsh-version-stamp.json
                                                     ▼
                                          ┌──────────────────────────────┐
                                          │ tar -C /root .dsh  → snapshot │
                                          └──────────────────────────────┘

【还原时 —— 检测/提取/判定/迁移】
  snapshot.tar.gz
        │  ① validateArchiveMembers()            （既有安全闸）
        ▼
  tar -xOzf ... .dsh/.dsh-version-stamp.json     （只抽清单，不解压全量）
        │  未命中 → synthesizeFromLayout()（老快照兜底）
        ▼
  evaluateRestoreCompatibility(stamp, currentDsh, matrix)
        │
        ├── COMPATIBLE / COMPATIBLE_WITH_NOTICE ──────────────► 直接应用
        ├── MIGRATION_REQUIRED ──► 预览迁移计划 ──确认──► 应用 → 引擎自动导入 → 写 migrationState
        ├── MIGRATION_REQUIRED_STRICT ──► 人工确认迁移计划 ──► 应用
        ├── DOWNGRADE_UNSUPPORTED ──► 硬拦截 ──force+二次确认──► 自动备份 → 应用（强告警）
        ├── RISK_WARNING ──► 强提示（建议连数据卷快照回滚）──► 应用
        ├── BLOCKED_INCOMPATIBLE ──► 拒绝（提示重新拉镜像）
        └── UNKNOWN_VERSION ──► 按布局推断 + 强制人工确认
        │
        ▼
  应用（staging → 原子切换 → 权限自愈）
        │  ⑤ 重新注入 home 级容器预设（防 T4）
        │  ⑥ bundles/pins 差异预检 → pnpm install
        │  ⑦ boot() 就绪验证
        └─ ⑧ 扫描 settings.yaml.imported 的 rejected sections → 回传提示
```

---

## 6. 版本兼容性矩阵与规则判定

### 6.1 布局 × 版本 兼容矩阵

`L` = legacy-settings，`P` = patch-layer。✅ 原生兼容 ／ ⚠️ 需迁移或提示 ／ ⛔ 不支持

| 快照布局 ＼ 当前 DSH | ≤0.1.4 | 0.1.5–0.1.6.x | 0.1.7-alpha.1 … 0.1.8 | ≥0.2.0 |
|---|---|---|---|---|
| **L**（含 `settings.yaml`） | ✅ COMPATIBLE | ✅ COMPATIBLE | ⚠️ **MIGRATION_REQUIRED**（自动导入） | ⛔ BLOCKED（`force-docker-pull`） |
| **P**（含 `cordis.patch.yml`） | ⛔ DOWNGRADE_UNSUPPORTED | ⛔ **DOWNGRADE_UNSUPPORTED** | ✅ COMPATIBLE / ℹ️ WITH_NOTICE | ⛔ BLOCKED |
| **hybrid** | ⛔ | ⚠️ STRICT | ⚠️ **MIGRATION_REQUIRED_STRICT** | ⛔ |
| **unknown** | ⚠️ UNKNOWN_VERSION | ⚠️ UNKNOWN_VERSION | ⚠️ UNKNOWN_VERSION | ⛔ |

### 6.2 配置项级平滑过渡方案

| 配置项 | legacy 载体（`settings.yaml` section） | patch-layer 载体（entry） | 过渡策略 |
|---|---|---|---|
| 引导/欢迎页版本 | `ui-onboarding` | `ui-settings-general.config.welcomeNoticeVersion` | 引擎自动映射（`LEGACY_SECTION_ENTRIES`），迁移后校验值一致 |
| 开发者工具 | `ui-developer-tools` | `ui-settings` | 同上 |
| Shell 执行器 | `shell` | `bash-sandbox` / `pwsh-sandbox`（按平台） | 同上；**跨平台迁移需按目标平台重映射** |
| 主题 | `ui-theme` | `ui-theme`（同名） | 同名直迁 |
| 模型 / provider | `llm-pi-ai` | `llm-pi-ai.config.providers` | 同名直迁；**迁移后必须校验 provider 完整性**（本仓库已有"安全闸"防丢 `llm-pi-ai`，`CHANGELOG.md:105`） |
| 默认模型 | `agent-default-model` | `agent-default-model.config` | 同名直迁；校验 `provider/model` 在迁移后仍存在 |
| 插件启停 | 无（旧版靠文件存在性） | `{ id, disabled: true }` entry | **新增能力**：旧快照的插件状态需从 `plugins-state.json` 转译 |
| 容器级预设 | 无 | home `cordis.patch.yml` | **仅在 home 层**（优先级最高、不被官方改写），restore 后重新注入（防 T4） |
| 网关配置 | `gateway.config.json` | 同（**不进快照**） | 补 `version`/`dshTargetVersion`/`__meta`；跨机迁移时随"导出包"单独携带 |
| 插件依赖 | `package.json.dependencies` | `+ dsh.profile.bundles[]` + `patchReload` | **并集策略**：保留旧依赖 + 补新 bundles；restore 前做 peer 预检，不兼容时用 `version-exemptions` |
| 会话数据 | V3 | **V4（单向）** | 降版**不可**就地兼容；规范要求降版必须连**数据卷快照**一起回滚 |

### 6.3 强制拦截（force）的护栏

对 `DOWNGRADE_UNSUPPORTED` / `BLOCKED_INCOMPATIBLE`，`force` 必须满足**全部**：

1. 前端二次确认：用户**手输**快照 `dshTargetVersion` 字符串；
2. 网关**强制**先创建一份"还原前快照"（复用 `createBackup({ type: 'full' })`）；
3. 记录审计：`{ actor, snapshot, fromVersion, toVersion, forced: true, at }` 落 `logs/`；
4. 返回体带 `forced: true` 与**不可撤销**警示文案；
5. `BLOCKED_INCOMPATIBLE`（≥0.2.0）**永不**允许 force，只允许 `force-docker-pull` 路径。

---

## 7. 落地实现方案（代码骨架）

### 7.1 新增 `gateway/config-version.js`（纯函数，可单测）

```js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValidVersion } = require('./dsh-version');

const STAMP_FILE = '.dsh-version-stamp.json';
const YAML_HEADER_BEGIN = '# ===== DSH CONFIG VERSION STAMP — DO NOT REMOVE =====';
const YAML_HEADER_END   = '# ====================================================';
const HEADER_RE = /^#\s*@([a-z0-9-]+):\s*(.+?)\s*$/gm;

/** 从 YAML 文本解析注释头（无头返回 null，绝不抛错） */
function parseYamlHeader(text) {
  const out = {};
  const head = String(text).split('\n').slice(0, 12).join('\n');
  let m;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(head)) !== null) out['@' + m[1]] = m[2];
  return Object.keys(out).length ? out : null;
}

/** 剥离既有 stamp 头（幂等注入的前提） */
function stripYamlHeader(text) {
  const lines = String(text).split('\n');
  const kept = lines.filter(l => !(l.startsWith('# @') || l === YAML_HEADER_BEGIN || l === YAML_HEADER_END));
  return kept.join('\n').replace(/^\n+/, '');
}

/** 生成 stamp 头（字段顺序稳定，便于 diff） */
function buildYamlHeader(stamp) {
  return [YAML_HEADER_BEGIN,
    `# @dsh-version: ${stamp.dshTargetVersion}`,
    `# @dsh-range: ${stamp.dshTargetRange || ''}`,
    `# @schema-version: ${stamp.schemaVersion}`,
    `# @layout: ${stamp.layout}`,
    `# @producer: ${stamp.producer}`,
    `# @tagged-at: ${stamp.taggedAt}`,
    `# @stamp-id: ${stamp.stampId}`,
    YAML_HEADER_END].join('\n');
}

/** 注入/刷新 YAML 注释头 */
function injectYamlHeader(text, stamp) {
  return buildYamlHeader(stamp) + '\n' + stripYamlHeader(text);
}

/** 为 JSON 配置注入保留字段（不删未知键，前向兼容） */
function injectJsonStamp(obj, stamp) {
  return { version: obj.version ?? 1, dshTargetVersion: stamp.dshTargetVersion,
           __meta: { ...(obj.__meta || {}), ...stamp }, ...obj,
           version: obj.version ?? 1, dshTargetVersion: stamp.dshTargetVersion };
}

/**
 * ★ 新增：求值复合区间（空格分隔 = AND）。修复 supportedDshRange 无法程序化求值（§1.5 缺口①）。
 * 建议置于 version-service.js 并具名导出；此处给出参考实现。
 */
function satisfiesRange(version, range) {
  if (!isSemver(version) || !range) return false;
  const terms = String(range).trim().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every(t => matchSemverPattern(version, t));
}

function detectLayout(dshDir) {
  const has = (p) => fs.existsSync(path.join(dshDir, p));
  const hasPatch  = has('cordis.patch.yml') || has('profiles/web/cordis.patch.yml');
  const hasLegacy = has('settings.yaml');
  const hasImport = has('settings.yaml.imported');
  if (hasPatch && hasLegacy) return 'hybrid';
  if (hasPatch) return 'patch-layer';
  if (hasLegacy || hasImport) return 'legacy-settings';
  return 'unknown';
}

const LAYOUT_BOUNDS = {
  'legacy-settings': { min: '0.1.2-rc.1', max: '0.1.6-alpha.2' },
  'patch-layer':     { min: '0.1.7-alpha.1', max: null },
  'hybrid':          { min: '0.1.7-alpha.1', max: null },
  'unknown':         { min: null, max: null },
};

function buildStamp({ dshTargetVersion, layout, producer, snapshot, fingerprint, dshTargetRange }) {
  if (!isValidVersion(dshTargetVersion)) throw new Error('非法 DSH 版本: ' + dshTargetVersion);
  const b = LAYOUT_BOUNDS[layout] || LAYOUT_BOUNDS.unknown;
  return {
    stampVersion: 1, schemaVersion: '1.0.0', kind: 'snapshot',
    stampId: crypto.randomUUID(), producer, taggedAt: new Date().toISOString(),
    dshTargetVersion, dshTargetRange: dshTargetRange || '',
    layout, layoutMinDsh: b.min, layoutMaxDsh: b.max,
    snapshot: snapshot || null,
    migrationState: { migrated: false, migratedAt: null, migratedBy: null, sectionsImported: [], sectionsRejected: [] },
    fingerprint: fingerprint || {},
  };
}

function writeStampFile(dshDir, stamp) {
  const tmp = path.join(dshDir, `.${STAMP_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(stamp, null, 2));
  fs.renameSync(tmp, path.join(dshDir, STAMP_FILE));   // 原子
}

function readStampFile(dshDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dshDir, STAMP_FILE), 'utf8')); } catch { return null; }
}

module.exports = { STAMP_FILE, parseYamlHeader, stripYamlHeader, buildYamlHeader, injectYamlHeader,
                   injectJsonStamp, satisfiesRange, detectLayout, buildStamp, writeStampFile, readStampFile, LAYOUT_BOUNDS };
```

### 7.2 新增 `gateway/restore-compat.js`（判定，复用既有矩阵）

```js
'use strict';
// ★ 前置改造：version-service.js 需具名导出下列纯函数（当前仅导出单例，见 §1.5 缺口②）
const { compareSemver, matchSemverPattern, isSemver, satisfiesRange } = require('./version-service');
const STATUS = Object.freeze({
  COMPATIBLE: 'COMPATIBLE',
  COMPATIBLE_WITH_NOTICE: 'COMPATIBLE_WITH_NOTICE',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  MIGRATION_REQUIRED_STRICT: 'MIGRATION_REQUIRED_STRICT',
  DOWNGRADE_UNSUPPORTED: 'DOWNGRADE_UNSUPPORTED',
  RISK_WARNING: 'RISK_WARNING',
  BLOCKED_INCOMPATIBLE: 'BLOCKED_INCOMPATIBLE',
  UNKNOWN_VERSION: 'UNKNOWN_VERSION',
});
const PATCH_LAYER_MIN = '0.1.7-alpha.1';
function evaluateRestoreCompatibility(stamp, currentDsh, matrix) { /* §5.2 逻辑 */ }
function buildMigrationPlan(stamp, currentDsh) {
  return {
    fromVersion: stamp.dshTargetVersion, toVersion: currentDsh,
    autoTriggered: true, engineHook: 'dsh-settings#importLegacyDocument',
    steps: [
      { id: 'rename',  desc: '引擎将 settings.yaml 改名为 settings.yaml.imported（先于写入，防重入）' },
      { id: 'import',  desc: '逐 section 映射导入：ui-onboarding→ui-settings-general、ui-developer-tools→ui-settings、shell→bash-sandbox' },
      { id: 'reject',  desc: '被当前组合拒绝的 section 仅留在 .imported，需人工复核' },
      { id: 'reinject',desc: '重新注入 home 级容器预设到 $DSH_HOME/cordis.patch.yml' },
      { id: 'deps',    desc: 'bundle/插件版本并集 + peer 预检（必要时 version-exemptions）' },
      { id: 'restamp', desc: '刷新 .dsh-version-stamp.json 为当前版本并记录 migrationState' },
    ],
  };
}
module.exports = { STATUS, evaluateRestoreCompatibility, buildMigrationPlan, PATCH_LAYER_MIN };
```

### 7.3 改造点清单

| 文件 | 改造 | 风险 |
|---|---|---|
| `gateway/backup-service.js:createBackup` | 增 stamp 注入 + 写清单（§4.2） | 低（新增文件） |
| `gateway/backup-service.js:restoreBackup` | 增"只抽清单 → 判定 → 分支"（§4.4） | **中**（主流程加闸，需保证不破坏既有回滚语义） |
| `gateway/backup-service.js:listBackups` | 返回项附带 `stamp`（适用版本） | 低 |
| `gateway/index.js` | 新增 `/api/snapshots/compat` 预检端点；restore 端点接受 `force`/`confirmVersion` | 低 |
| `gateway/public/admin.html` | 快照列表显示"适用版本/布局/状态"徽标；还原前弹兼容性面板 | 低 |
| `version.json:compatibility` | 新增 `configLayouts` 与 `migrationRules`（保持单一数据源） | 低 |
| **`gateway/version-service.js`** | **具名导出 `parseSemver`/`isSemver`/`compareSemver`/`matchSemverPattern`，并新增 `satisfiesRange`（§1.5 缺口①②）** | **中**（改动公共模块导出面，需回归 `version-matrix-sync-test.mjs`） |
| 所有 `cordis.patch.yml` 写入方 | 收敛到 `writePatchFile()`（§3.1.3） | **中**（触及插件管理器/设置写入路径） |
| `scripts/version-matrix-sync-test.mjs` | 扩展断言：`configLayouts`/`migrationRules` 同步 | 低 |

### 7.4 `version.json` 增量（单一数据源）

```jsonc
"compatibility": {
  "configLayouts": [
    { "layout": "legacy-settings", "minDsh": "0.1.2-rc.1", "maxDsh": "0.1.6-alpha.2",
      "authoritativeFile": "settings.yaml", "marker": "settings.yaml" },
    { "layout": "patch-layer", "minDsh": "0.1.7-alpha.1", "maxDsh": null,
      "authoritativeFile": "cordis.patch.yml", "marker": "cordis.patch.yml" }
  ],
  "migrationRules": [
    { "from": "legacy-settings", "toDsh": ">=0.1.7-alpha.1", "status": "MIGRATION_REQUIRED",
      "engineHook": "dsh-settings#importLegacyDocument", "autoTriggered": true,
      "trap": "重复还原同一 legacy 快照会重复导入并回退用户改值" },
    { "from": "patch-layer", "toDsh": "<0.1.7-alpha.1", "status": "DOWNGRADE_UNSUPPORTED",
      "severity": "danger", "trap": "旧版不读 cordis.patch.yml → 补丁层配置静默全丢 + V4 会话不可读" }
  ],
  "rules": [ /* 既有规则保持不变 */ ]
}
```

### 7.5 回归测试清单（新增 `scripts/config-version-stamp-test.mjs`）

1. `parseYamlHeader` / `stripYamlHeader` / `injectYamlHeader` 幂等性（注入两次结果一致）；
2. `injectYamlHeader` 后 `js-yaml` 解析结果与注入前**语义等价**（注释不影响解析）；
3. `detectLayout` 对 4 种布局 fixture（含 `tmp/audit-config/home017` 真实样本）判定正确；
4. `evaluateRestoreCompatibility` 覆盖 8 个状态枚举的用例矩阵；
5. 场景 B 端到端：构造含 `settings.yaml` 的 fixture 快照 → 判定 `MIGRATION_REQUIRED` → 迁移后 `settings.yaml.imported` 存在且 `migrationState.migrated === true`；
6. 场景 C 拦截：patch-layer 快照 + 模拟 0.1.6 → 必须返回 `DOWNGRADE_UNSUPPORTED` 且默认拒绝；
7. `validateArchiveMembers` 对含 `.dsh/.dsh-version-stamp.json` 的归档仍通过；
8. 老快照（无清单）→ `UNKNOWN_VERSION` + `synthesizeFromLayout` 兜底不崩。

---

## 8. 风险登记与开放问题

| # | 风险/问题 | 影响 | 建议 |
|---|---|---|---|
| R1 | 引擎 `importLegacyDocument` 的 `update()` 落盘位置未在源码中显式确认（实测表现为 profile/home patch） | 迁移目标层不确定 | 落地前用 fixture 实测确认，并在 stamp 记录实际落盘文件 |
| R2 | `gateway.config.json` 被排除出快照 → 跨机迁移缺网关配置 | 迁移不完整 | 增设"导出包"（`tar` 时显式携带脱敏后的 gateway config） |
| R3 | 官方整文件读-改-写可能丢弃我们的 `__meta`（对 `plugins-state.json`/`package.json`） | 标记丢失 | 采用旁路 fingerprint（§3.2.2），不碰官方文件 |
| R4 | `!!js` 表达式在 patch 中求值，跨版本可能语义变化 | 静默行为差异 | 迁移后 diff 组合结果（`dsh --dump-config`） |
| R5 | 会话 V4 单向迁移 | 降版数据不可读 | 已有矩阵规则覆盖；规范要求降版必须连数据卷快照回滚 |
| R6 | `profile.home` 与 profile 目录不一致 | 检测位置错误 | 统一以 `$DSH_HOME` 为基准（T6） |
| R7 | 老快照无标记 | 误判 | `UNKNOWN_VERSION` + 强制人工确认，绝不静默应用 |

---

## 附录 A：Version Stamp 字段字典

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `stampVersion` | int | ✅ | Stamp 结构版本 |
| `schemaVersion` | string | ✅ | 被标记文件的 schema 版本（语义化） |
| `kind` | enum | ✅ | `snapshot` / `home` / `file` |
| `stampId` | uuid | ✅ | 唯一标识（去重/追溯） |
| `producer` | string | ✅ | `deepseek-harness-docker@<ver>` |
| `taggedAt` | ISO8601 | ✅ | 打标时间 |
| `dshTargetVersion` | semver | ✅ | 打标时的运行 DSH 版本 |
| `dshTargetRange` | string | ➖ | 该配置适用的 DSH 区间 |
| `layout` | enum | ✅ | `legacy-settings` / `patch-layer` / `hybrid` / `unknown` |
| `layoutMinDsh` / `layoutMaxDsh` | semver/null | ➖ | 布局原生支持边界 |
| `snapshot` | object | ➖ | `{name,type,createdAt}` |
| `migrationState` | object | ✅ | `{migrated,migratedAt,migratedBy,sectionsImported,sectionsRejected}` |
| `fingerprint` | object | ➖ | 关键文件哈希 + `bundles[]` + `pluginPins{}` |
| `files` | array | ➖ | 逐文件内标记汇总 |

## 附录 B：状态枚举 ↔ 既有 `rule.level` 映射

| Status | level | 前端呈现 |
|---|---|---|
| `COMPATIBLE` | `ok` | 绿色 ✅ 直接还原 |
| `COMPATIBLE_WITH_NOTICE` | `info` | 蓝色 ℹ️ 提示后还原 |
| `MIGRATION_REQUIRED` | `warning` | 黄色 ⚠️ 展示迁移计划 → 确认 |
| `MIGRATION_REQUIRED_STRICT` | `warning` | 黄色 ⚠️ 人工确认迁移计划 |
| `RISK_WARNING` | `warning` | 黄色 ⚠️ 强提示 + 建议数据卷回滚 |
| `DOWNGRADE_UNSUPPORTED` | `danger` | 红色 ⛔ 拦截 + 输入版本号强制 |
| `BLOCKED_INCOMPATIBLE` | `danger` | 红色 ⛔ 拒绝（`force-docker-pull`） |
| `UNKNOWN_VERSION` | `warning` | 黄色 ⚠️ 强制人工确认 |

---

*本规范与 `version.json:compatibility` 保持单一数据源；任何新增版本边界必须同步 `scripts/version-matrix-sync-test.mjs` 断言。*

---

## 附录 C：实机验证结果（本规范的证据）

以下为编写本规范时在**本机真实环境**跑出的验证结论，可作为评审与落地验收基线。

### C.1 注释头方案 parse-safe（已验证）

用引擎自带的 `js-yaml` 对真实文件 `~/.dsh/profiles/web/cordis.patch.yml` 验证：

```
before isArray: true  len 10
after  isArray: true  len 10
deep-equal: true                      ← 注入注释头后解析结果完全一致
```

对 `~/.dsh/settings.yaml.imported`（对象根，10 个 section）：

```
settings sections before/after: 10 10   equal: true
```

**反证**（为何不能用 top-level 字段）：对 `cordis.patch.yml` 加 `__schema_version: "1.0.0"` 顶层字段后：

```
topfield parse error: end of the stream or a document separator is expected (6:1)
```

→ 直接**解析失败**，证实 §3.1.1 的结论。

### C.2 `detectLayout` 对真实样本（已验证）

| 目录 | 判定 |
|---|---|
| `/root/.dsh`（当前生产 home） | `patch-layer` |
| `tmp/audit-config/home017`（仓库内 0.1.7 审计样本） | `patch-layer` |
| `/tmp/test-dsh/.dsh` | `patch-layer` |
| `/tmp/dsh-review-rc2/package` | `patch-layer` |

### C.3 状态判定矩阵（已验证，8/8 正确）

```
COMPATIBLE                           A 同版本 0.1.7→0.1.7
MIGRATION_REQUIRED +confirm          B 升版 0.1.6快照→0.1.7
DOWNGRADE_UNSUPPORTED +force         C 降版 0.1.7快照→0.1.6
MIGRATION_REQUIRED_STRICT +confirm   hybrid 同版本
UNKNOWN_VERSION +confirm             老快照无标记
BLOCKED_INCOMPATIBLE                 0.2.0 阻断
COMPATIBLE_WITH_NOTICE               patch 跨patch alpha.1→rc.1
RISK_WARNING                         legacy 0.1.2→0.1.5
```

### C.4 `satisfiesRange` 修正前后对比（已验证）

| 版本 | 修正前 `matchSemverPattern(v, supportedDshRange)` | 修正后 `satisfiesRange(v, supportedDshRange)` |
|---|---|---|
| `0.1.7-rc.2` | true | ✅ IN |
| `0.1.7-rc.3` | true（**误判**） | ✅ OUT |
| `0.1.8` | true（**误判**） | ✅ OUT |
| `0.2.0` | true（**误判，危险**） | ✅ OUT |

→ 修正前会把 0.2.0（`action: force-docker-pull` 的硬阻断版本）误判为兼容，属**安全相关缺陷**。
