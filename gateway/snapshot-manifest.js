'use strict';
/**
 * snapshot-manifest.js — 快照版本元数据（Snapshot Manifest）参考实现
 * ---------------------------------------------------------------------------
 * 目标：让每一个配置快照都自带「它是哪个 DSH 引擎版本 / 哪一代配置模型下产生的」
 * 这一事实，从而在还原前即可完成版本兼容性判定，而不必先解压几百 MB 归档。
 *
 * 设计要点（详见 doc/design/snapshot-version-manifest.md）：
 *  1. 元数据作为普通文件成员 `.dsh/.dsh-meta/snapshot.json` 打进归档，位于 `.dsh/` 之下，
 *     因此现有 validateArchiveMembers() 白名单无需放宽即可通过（fail-closed 不变）。
 *  2. 该成员被放在归档**首位**，`tar -xzOf --occurrence=1` 可近乎 O(1) 读取。
 *  3. 同时落一份隐藏 sidecar `.<filename>.meta.json`，listBackups() 免解压即可列出。
 *  4. 对无元数据的历史旧快照，按结构（settings.yaml vs cordis.patch.yml）智能推断。
 *
 * 本模块为纯逻辑 + 最小 tar 依赖，便于单元测试；不 require backup-service，避免循环依赖。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── 常量 ──────────────────────────────────────────────────────────────────
/** Manifest JSON 自身的格式版本（字段增删时 +1；与 DSH 版本无关） */
const MANIFEST_SCHEMA_VERSION = 1;
/** 归档内成员路径（位于 .dsh/ 之下，白名单天然放行） */
const MANIFEST_MEMBER = '.dsh/.dsh-meta/snapshot.json';
/** 归档内专属目录（archive-owned，live 树不应长期保留） */
const MANIFEST_DIR_IN_DSH = '.dsh-meta';
/** sidecar 命名：隐藏文件，天然被 listBackups 的 `!f.startsWith('.')` 过滤 */
const SIDECAR_SUFFIX = '.meta.json';
const SIDECAR_PREFIX = '.';

/** 配置模型「世代」——版本兼容判定的核心轴 */
const CONFIG_SCHEMA = Object.freeze({
  SETTINGS_FILE: 1, // <= 0.1.6.x：$DSH_HOME/.dsh/settings.yaml（dsh-settings-file 后端）
  PATCH_LAYER: 2    // >= 0.1.7.x：profile cordis.patch.yml + Home 级 cordis.patch.yml
});
const CONFIG_MODEL_LABEL = Object.freeze({
  1: 'settings-file',
  2: 'patch-layer'
});
/** 世代切换的分水岭版本（官方 0.1.7-alpha.1 引入 Settings 子系统 / Home patch 层） */
const PATCH_LAYER_EPOCH = '0.1.7-alpha.1';

// ── SemVer（自包含，语义与 version-service.js 保持一致） ────────────────────
function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
}
function isValidSemver(v) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());
}
function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  return p1.pre.localeCompare(p2.pre);
}
function sameMajorMinor(a, b) {
  const p1 = parseSemver(a);
  const p2 = parseSemver(b);
  return p1.major === p2.major && p1.minor === p2.minor;
}
/** 由引擎版本推断配置模型世代 */
function configSchemaForDshVersion(dshVersion) {
  if (!isValidSemver(dshVersion)) return null;
  return compareSemver(dshVersion, PATCH_LAYER_EPOCH) >= 0
    ? CONFIG_SCHEMA.PATCH_LAYER
    : CONFIG_SCHEMA.SETTINGS_FILE;
}

// ── 极小 tar 封装（异步、带超时与输出上限，避免阻塞事件循环 / 内存打满） ──────
function runTarAsync(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60 * 1000;
  const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`tar 超时(${Math.round(timeoutMs / 1000)}s): tar ${args.join(' ')}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onData = (chunk, isErr) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('tar 输出超限（可能是损坏/异常归档）'));
        return;
      }
      if (isErr) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', d => onData(d, false));
    child.stderr.on('data', d => onData(d, true));
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.on('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
  });
}

/** 读取归档内的 manifest 成员（manifest 位于首位时近乎 O(1)） */
async function readManifestFromArchive(archivePath) {
  const res = await runTarAsync(
    ['-xzOf', archivePath, '--occurrence=1', MANIFEST_MEMBER],
    { timeoutMs: 120 * 1000, maxOutputBytes: 4 * 1024 * 1024 }
  );
  if (res.code !== 0 || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/** 列出归档成员（仅用于旧快照推断 / 诊断，成本较高，务必配合 sidecar 缓存） */
async function listMembers(archivePath) {
  const res = await runTarAsync(['-tzf', archivePath], { timeoutMs: 300 * 1000, maxOutputBytes: 64 * 1024 * 1024 });
  if (res.code !== 0) throw new Error('无法列出归档成员: ' + (res.stderr || '未知错误'));
  return res.stdout.split('\n').map(s => s.replace(/\s+$/, '')).filter(Boolean);
}

/** 从归档中抽取单个成员到内存（用于读 profiles/web/package.json 等小文件） */
async function readMemberFromArchive(archivePath, member) {
  const res = await runTarAsync(
    ['-xzOf', archivePath, '--occurrence=1', member],
    { timeoutMs: 120 * 1000, maxOutputBytes: 8 * 1024 * 1024 }
  );
  return res.code === 0 ? res.stdout : null;
}

// ── Manifest 构建 ─────────────────────────────────────────────────────────
/**
 * 规范化 JSON（键排序、去空白），用于稳定 hash：同一逻辑内容 → 同一指纹。
 */
function canonicalJson(obj) {
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * 组装 manifest（不含自指纹；由 finalizeManifest 补齐）。
 * @param {object} ctx
 */
function buildManifest(ctx = {}) {
  const now = new Date();
  const dshVersion = ctx.dshVersion || null;
  const schemaVersion = ctx.schemaVersion
    ?? configSchemaForDshVersion(dshVersion)
    ?? null;
  const projectVersion = ctx.projectVersion || null;

  return {
    // —— 身份与来源 ——
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    generator: 'deepseek-harness-docker/gateway/backup-service',
    generatorVersion: projectVersion,                 // 套件（项目）版本
    dockerSuiteVersion: projectVersion,               // 显式别名，便于前端/文档直读
    imageRevision: ctx.imageRevision || null,         // 如 proj0.1.8-dsh0.1.7-rc.1
    // —— 版本轴 ——
    dshVersion,                                        // 产生该快照时实际运行的 DSH 引擎版本
    dshVersionSource: ctx.dshVersionSource || 'unknown', // package.json|probe|cli|fallback|injected|unknown
    schemaVersion,                                     // 配置模型世代（1=settings-file, 2=patch-layer）
    configModel: CONFIG_MODEL_LABEL[schemaVersion] || 'unknown',
    // —— 归档属性 ——
    backupType: ctx.backupType === 'config' ? 'config' : 'full',
    createdAt: now.toISOString(),
    createdAtEpochMs: now.getTime(),
    name: ctx.name || '',
    // —— 兼容区间（快照产生时刻的供应链声明，作为「历史事实」留档） ——
    compatibilityRange: ctx.compatibilityRange || null,
    // —— 内容指纹（用于快速判断「里面有没有某个配置文件」） ——
    contents: ctx.contents || null,
    // —— 宿主环境（跨机还原排障） ——
    host: ctx.host || null,
    // —— 归档统计（可选，创建后回填到 sidecar） ——
    archive: ctx.archive || null,
    // —— 完整性 ——
    filesHash: {
      algorithm: 'sha256',
      manifestSelfHash: null,   // finalize 时补齐
      configTreeHash: null,     // 可选：配置树摘要（异步计算）
      fileCount: ctx.fileCount ?? null,
      totalBytes: ctx.totalBytes ?? null
    }
  };
}

/** 计算并写入 manifest 自指纹（覆盖除 manifestSelfHash 之外的全部字段） */
function finalizeManifest(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.filesHash.manifestSelfHash = null;
  const hash = sha256Hex(canonicalJson(clone));
  manifest.filesHash.manifestSelfHash = hash;
  return manifest;
}

/** 校验 manifest 自指纹（损坏/被篡改检测） */
function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest 缺失或非对象' };
  const expect = manifest.filesHash && manifest.filesHash.manifestSelfHash;
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.filesHash.manifestSelfHash = null;
  const actual = sha256Hex(canonicalJson(clone));
  if (!expect) return { ok: false, reason: '缺少 manifestSelfHash' };
  return expect === actual ? { ok: true } : { ok: false, reason: 'manifestSelfHash 不匹配（内容被改动）' };
}

// ── sidecar 缓存（listBackups 免解压的关键） ────────────────────────────────
function sidecarPath(snapshotsDir, filename) {
  return path.join(snapshotsDir, `${SIDECAR_PREFIX}${filename}${SIDECAR_SUFFIX}`);
}

function readSidecar(snapshotsDir, filename) {
  try {
    const p = sidecarPath(snapshotsDir, filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeSidecarAtomic(snapshotsDir, filename, payload) {
  const target = sidecarPath(snapshotsDir, filename);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

function removeSidecar(snapshotsDir, filename) {
  try {
    const p = sidecarPath(snapshotsDir, filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** sidecar 是否仍然对应当前归档文件（大小 + mtime 双重比对，防止文件被替换后缓存失真） */
function sidecarIsFresh(sidecar, stat) {
  if (!sidecar || !sidecar.archive) return false;
  return Number(sidecar.archive.sizeBytes) === Number(stat.size)
    && Number(sidecar.archive.mtimeMs) === Math.floor(stat.mtimeMs);
}

// ── 旧快照版本推断 ─────────────────────────────────────────────────────────
/**
 * 依据归档成员结构推断快照的版本与世代。
 * 这是「存量旧快照」向后兼容的核心：无需元数据也能给出可用结论 + 置信度。
 */
function inferFromMembers(members, filename = '') {
  const set = new Set(members.map(m => m.replace(/\/+$/, '')));
  const has = p => set.has(p);
  const anyUnder = prefix => members.some(m => m === prefix || m.startsWith(prefix + '/'));

  const signals = [];
  const hasSettingsYaml = has('.dsh/settings.yaml');
  const hasSettingsImported = has('.dsh/settings.yaml.imported');
  const hasHomePatch = has('.dsh/cordis.patch.yml');
  const hasProfilesDir = anyUnder('.dsh/profiles');
  const hasSessions = anyUnder('.dsh/sessions');
  const hasCredentials = has('.dsh/.credentials.yaml');

  let schemaVersion = null;
  let confidence = 'low';

  // 信号 1（最强）：cordis.patch.yml / settings.yaml.imported 是 0.1.7+ 独有产物
  if (hasHomePatch || hasSettingsImported) {
    schemaVersion = CONFIG_SCHEMA.PATCH_LAYER;
    confidence = 'high';
    signals.push(hasSettingsImported ? '存在 settings.yaml.imported（0.1.7+ 一次性迁移产物）'
      : '存在 Home 级 cordis.patch.yml（0.1.7+ 补丁层）');
  } else if (hasSettingsYaml) {
    schemaVersion = CONFIG_SCHEMA.SETTINGS_FILE;
    confidence = 'high';
    signals.push('存在 settings.yaml 且无 cordis.patch.yml（0.1.6 及以前 settings-file 模型）');
  } else if (hasProfilesDir) {
    // 无强标记：按 profiles 目录结构 + 文件名兜底
    schemaVersion = null;
    confidence = 'low';
    signals.push('仅见 profiles/ 目录，无法判定世代');
  }

  // 文件名时间戳（backupType + createdAt 兜底）
  const backupType = /(^|[-_])config([-_]|\.)/.test(filename) ? 'config' : 'full';

  return {
    inferred: true,
    confidence,
    signals,
    backupType,
    schemaVersion,
    configModel: CONFIG_MODEL_LABEL[schemaVersion] || 'unknown',
    dshVersion: null,                    // 结构推断只能给世代，给不出精确版本
    dshVersionRange: schemaVersion === CONFIG_SCHEMA.PATCH_LAYER ? `>=${PATCH_LAYER_EPOCH}`
      : schemaVersion === CONFIG_SCHEMA.SETTINGS_FILE ? `<${PATCH_LAYER_EPOCH}` : null,
    contents: { hasSettingsYaml, hasSettingsImported, hasCordisPatchYml: hasHomePatch, hasProfilesDir, hasSessions, hasCredentials }
  };
}

// ── 归档检视（listBackups / inspect API 共用） ──────────────────────────────
/**
 * 读取快照元数据：sidecar 优先 → 归档内 manifest → 结构推断。
 * 结果会被写入 sidecar，使后续调用 O(1)。
 * @returns {Promise<object>} { filename, meta, metaSource, confidence, verified, archive }
 */
async function inspectArchive(archivePath, opts = {}) {
  const filename = opts.filename || path.basename(archivePath);
  const snapshotsDir = opts.snapshotsDir || path.dirname(archivePath);
  const stat = fs.statSync(archivePath);
  const archive = { sizeBytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };

  // 1) sidecar 命中（且新鲜）
  if (!opts.force) {
    const sc = readSidecar(snapshotsDir, filename);
    if (sidecarIsFresh(sc, stat) && sc.meta) {
      return { filename, meta: sc.meta, metaSource: sc.metaSource || 'sidecar', confidence: sc.confidence || 'high', verified: Boolean(sc.verified), archive, fromCache: true };
    }
  }

  // 2) 归档内 manifest
  let meta = null;
  let metaSource = 'none';
  let confidence = 'none';
  let verified = false;
  try {
    const inline = await readManifestFromArchive(archivePath);
    if (inline && inline.manifestVersion) {
      meta = inline;
      metaSource = 'inline';
      confidence = 'high';
      const v = verifyManifest(inline);
      verified = v.ok;
    }
  } catch { /* 归档损坏时退化为推断 */ }

  // 3) 结构推断（历史旧快照）
  if (!meta) {
    try {
      const members = await listMembers(archivePath);
      const inf = inferFromMembers(members, filename);
      meta = buildManifest({
        dshVersion: null,
        dshVersionSource: 'inferred',
        schemaVersion: inf.schemaVersion,
        backupType: inf.backupType,
        name: filename.replace(/\.tar\.gz$/i, ''),
        contents: inf.contents
      });
      meta.inferred = true;
      meta.inference = { confidence: inf.confidence, signals: inf.signals, dshVersionRange: inf.dshVersionRange };
      finalizeManifest(meta);
      metaSource = 'inferred';
      confidence = inf.confidence;
    } catch {
      meta = null;
    }
  }

  const payload = { meta, metaSource, confidence, verified, archive };
  if (meta) writeSidecarAtomic(snapshotsDir, filename, payload);
  return { filename, ...payload, fromCache: false };
}

// ── 版本兼容性判定 ─────────────────────────────────────────────────────────
/**
 * 判定「把该快照还原到当前系统」的风险等级。
 *
 * @param {object} snapshotMeta  快照 manifest（可为推断结果）
 * @param {object} current       { dshVersion, schemaVersion, projectVersion }
 * @param {object} [opts]        { rules } version.json 的 compatibility.rules（单一数据源）
 * @returns {object} verdict
 */
function assessCompatibility(snapshotMeta, current, opts = {}) {
  const snapVer = snapshotMeta && snapshotMeta.dshVersion;
  const snapSchema = snapshotMeta && snapshotMeta.schemaVersion;
  const curVer = current && current.dshVersion;
  const curSchema = current && current.schemaVersion;

  const messages = [];
  let level = 'ok';
  let code = 'EXACT_MATCH';
  const bump = lv => {
    const w = { ok: 0, info: 1, warning: 2, danger: 3, unknown: 2 };
    if ((w[lv] || 0) > (w[level] || 0)) level = lv;
  };

  // 1) 版本号缺失 → 未知，必须显式确认
  if (!isValidSemver(snapVer) || !isValidSemver(curVer)) {
    code = 'UNKNOWN_VERSION';
    bump('unknown');
    messages.push({
      level: 'unknown',
      title: '无法确定快照 DSH 版本',
      message: snapshotMeta && snapshotMeta.inferred
        ? `该快照不含版本元数据，仅按结构推断（置信度 ${snapshotMeta.inference?.confidence || 'low'}）。` +
          `${snapshotMeta.inference?.dshVersionRange ? `推断适用区间：${snapshotMeta.inference.dshVersionRange}。` : ''}请确认后再还原。`
        : `快照或当前系统的 DSH 版本无法解析（快照=${snapVer || '未知'}，当前=${curVer || '未知'}）。`,
      action: 'acknowledge'
    });
  } else {
    const cmp = compareSemver(snapVer, curVer);
    const sp = parseSemver(snapVer);
    const cp = parseSemver(curVer);

    if (cmp === 0) {
      code = 'EXACT_MATCH';
      messages.push({ level: 'ok', title: '版本完全一致', message: `快照与当前系统同为 v${curVer}，还原风险最低。` });
    } else if (sp.major === cp.major && sp.minor === cp.minor) {
      code = 'PATCH_DIFF';
      bump('info');
      messages.push({ level: 'info', title: '同主次版本（补丁差异）', message: `快照 v${snapVer} 与当前 v${curVer} 属同一主次版本，配置模型一致，通常可直接还原。` });
    } else if (sp.major === cp.major) {
      // 同主版本、次版本不同：跨世代风险由 schema 轴进一步升级
      code = cmp < 0 ? 'MINOR_DOWNGRADE' : 'MINOR_UPGRADE';
      bump('warning');
      messages.push({
        level: 'warning',
        title: cmp < 0 ? '跨次版本降级' : '跨次版本升级',
        message: `快照 v${snapVer} 与当前 v${curVer} 次版本不同${cmp < 0 ? '（降级）' : '（升级）'}，可能存在配置字段增删，还原后请复核设置。`
      });
    } else {
      code = 'MAJOR_DIFF';
      bump('danger');
      messages.push({
        level: 'danger',
        title: '主版本不一致',
        message: `快照 v${snapVer} 与当前 v${curVer} 主版本不同，官方底层架构/协议可能已重构，还原后配置未必被识别。`
      });
    }
  }

  // 2) 配置模型世代轴（比版本号更贴近「配置能否被读取」）
  if (snapSchema != null && curSchema != null && snapSchema !== curSchema) {
    code = code === 'UNKNOWN_VERSION' ? code : 'SCHEMA_ERA_CROSS';
    if (snapSchema > curSchema) {
      // 新世代快照 → 旧世代系统：cordis.patch.yml 会被忽略 → 配置丢失
      bump('danger');
      messages.push({
        level: 'danger',
        title: '配置模型不兼容（新→旧）',
        message: `快照使用 ${CONFIG_MODEL_LABEL[snapSchema]}（${snapSchema}）模型，当前系统为 ${CONFIG_MODEL_LABEL[curSchema]}（${curSchema}）模型；` +
          `旧引擎不识别 cordis.patch.yml，还原后补丁层配置将失效。建议升级 DSH 至 >= ${PATCH_LAYER_EPOCH} 后再还原。`
      });
    } else {
      // 旧世代快照 → 新世代系统：settings.yaml 会被一次性导入并改名
      bump('warning');
      messages.push({
        level: 'warning',
        title: '配置模型跨代（旧→新，一次性导入）',
        message: `快照为 ${CONFIG_MODEL_LABEL[snapSchema]}（${snapSchema}）模型，当前为 ${CONFIG_MODEL_LABEL[curSchema]}（${curSchema}）模型；` +
          `旧 settings.yaml 会在 DSH 启动时被导入一次并改名为 settings.yaml.imported，导入后以补丁层为权威。`
      });
    }
  }

  // 3) 复用 version.json 的官方兼容规则（单一数据源，避免规则漂移）
  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  if (isValidSemver(snapVer)) {
    const sev = { danger: 3, warning: 2, info: 1 };
    for (const rule of [...rules].sort((a, b) => (sev[b.level] || 0) - (sev[a.level] || 0))) {
      if (matchSemverPattern(snapVer, rule.pattern)) {
        bump(rule.level === 'danger' ? 'danger' : rule.level === 'warning' ? 'warning' : 'info');
        messages.push({ level: rule.level || 'warning', title: rule.title || '版本兼容性提示', message: rule.message || '', action: rule.action || '' });
        break; // 命中最高危规则即止
      }
    }
  }

  const requiresAcknowledgement = level === 'warning' || level === 'danger' || level === 'unknown';
  const canProceed = level !== 'danger' || opts.allowDanger === true;

  return {
    level,
    code,
    snapshot: { dshVersion: snapVer || null, schemaVersion: snapSchema ?? null, configModel: CONFIG_MODEL_LABEL[snapSchema] || 'unknown', inferred: Boolean(snapshotMeta && snapshotMeta.inferred) },
    current: { dshVersion: curVer || null, schemaVersion: curSchema ?? null, configModel: CONFIG_MODEL_LABEL[curSchema] || 'unknown' },
    messages,
    requiresAcknowledgement,
    canProceed
  };
}

function matchSemverPattern(ver, pattern) {
  if (!ver || !pattern) return false;
  const p = String(pattern).trim();
  if (p.startsWith('>=')) return compareSemver(ver, p.slice(2).trim()) >= 0;
  if (p.startsWith('>')) return compareSemver(ver, p.slice(1).trim()) > 0;
  if (p.startsWith('<=')) return compareSemver(ver, p.slice(2).trim()) <= 0;
  if (p.startsWith('<')) return compareSemver(ver, p.slice(1).trim()) < 0;
  if (p.startsWith('=')) return compareSemver(ver, p.slice(1).trim()) === 0;
  return compareSemver(ver, p) === 0;
}

// ── 单文件配置的版本标识（gateway.config.json / cordis.patch.yml） ──────────
const YAML_STAMP_BEGIN = '# >>> dsh-snapshot-meta (auto-generated, do not edit) >>>';
const YAML_STAMP_END = '# <<< dsh-snapshot-meta <<<';

/** 生成要写入配置文件的版本戳（精简版，避免污染配置语义） */
function buildFileStamp(ctx = {}) {
  return {
    dshVersion: ctx.dshVersion || null,
    schemaVersion: ctx.schemaVersion ?? configSchemaForDshVersion(ctx.dshVersion),
    configModel: CONFIG_MODEL_LABEL[ctx.schemaVersion ?? configSchemaForDshVersion(ctx.dshVersion)] || 'unknown',
    dockerSuiteVersion: ctx.projectVersion || null,
    imageRevision: ctx.imageRevision || null,
    stampedAt: new Date().toISOString()
  };
}

/** 给 JSON 配置对象打戳（幂等：覆盖旧的 _snapshotMeta） */
function stampJsonConfig(obj, stamp) {
  if (!obj || typeof obj !== 'object') return obj;
  return { ...obj, _snapshotMeta: { ...buildFileStamp(stamp), note: 'DSH 套件写入的版本标识，供备份/还原兼容性判定使用' } };
}

/** 读取 JSON 配置里的版本戳 */
function readJsonStamp(obj) {
  return obj && typeof obj === 'object' && obj._snapshotMeta ? obj._snapshotMeta : null;
}

/**
 * 给 YAML 文本打戳：以**注释块**形式置于文件头部。
 * 注释不参与 YAML 解析，因此不改变任何配置语义；幂等（先删旧块再写新块）。
 */
function stampYamlText(text, stamp) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = [
    YAML_STAMP_BEGIN,
    ...Object.entries(buildFileStamp(stamp)).map(([k, v]) => `# ${k}: ${v == null ? 'null' : v}`),
    YAML_STAMP_END
  ].join('\n');
  const cleaned = stripYamlStamp(body);
  return `${lines}\n${cleaned.replace(/^\n+/, '')}`;
}

function stripYamlStamp(text) {
  const re = new RegExp(`${escapeRe(YAML_STAMP_BEGIN)}[\\s\\S]*?${escapeRe(YAML_STAMP_END)}\\n?`, 'g');
  return String(text ?? '').replace(re, '');
}

function readYamlStamp(text) {
  const re = new RegExp(`${escapeRe(YAML_STAMP_BEGIN)}\\n([\\s\\S]*?)\\n${escapeRe(YAML_STAMP_END)}`);
  const m = String(text ?? '').match(re);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^#\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2] === 'null' ? null : mm[2];
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  // 常量
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_MEMBER,
  MANIFEST_DIR_IN_DSH,
  CONFIG_SCHEMA,
  CONFIG_MODEL_LABEL,
  PATCH_LAYER_EPOCH,
  // semver
  parseSemver,
  isValidSemver,
  compareSemver,
  sameMajorMinor,
  matchSemverPattern,
  configSchemaForDshVersion,
  // tar
  runTarAsync,
  readManifestFromArchive,
  listMembers,
  readMemberFromArchive,
  // manifest
  canonicalJson,
  sha256Hex,
  buildManifest,
  finalizeManifest,
  verifyManifest,
  // sidecar
  sidecarPath,
  readSidecar,
  writeSidecarAtomic,
  removeSidecar,
  sidecarIsFresh,
  // 推断 / 检视
  inferFromMembers,
  inspectArchive,
  // 兼容判定
  assessCompatibility,
  // 配置戳
  buildFileStamp,
  stampJsonConfig,
  readJsonStamp,
  stampYamlText,
  stripYamlStamp,
  readYamlStamp
};
