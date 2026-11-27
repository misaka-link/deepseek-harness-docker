'use strict';
/**
 * snapshot-manifest.js — 快照版本元数据与历史世代兼容推断。
 *
 * 保留全部 0.1.x / 0.2.x 旧快照兼容识别能力：
 *   - 无 manifest 历史归档按成员结构推断 Schema 1 (settings.yaml) / Schema 2 (cordis.patch.yml)
 *   - 支持 ./.dsh/ 与 .dsh/ 两种归档前缀
 *   - 对 Schema 1 (settings.yaml) 归档标注 legacySettingsWarning: true
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseSemver, compareSemver, isSemver, matchSemverPattern } = require('../core/semver');

const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_MEMBER = '.dsh/.dsh-meta/snapshot.json';
const MANIFEST_DIR_IN_DSH = '.dsh-meta';
const SIDECAR_SUFFIX = '.meta.json';
const SIDECAR_PREFIX = '.';

const CONFIG_SCHEMA = Object.freeze({
  SETTINGS_FILE: 1, // <= 0.1.6.x：$DSH_HOME/.dsh/settings.yaml
  PATCH_LAYER: 2    // >= 0.1.7.x：profile cordis.patch.yml + Home 级 cordis.patch.yml
});

const CONFIG_MODEL_LABEL = Object.freeze({
  1: 'settings-file',
  2: 'patch-layer'
});

const PATCH_LAYER_EPOCH = '0.1.7-alpha.1';

function isValidSemver(v) {
  return isSemver(v);
}

function sameMajorMinor(a, b) {
  const p1 = parseSemver(a);
  const p2 = parseSemver(b);
  return p1.major === p2.major && p1.minor === p2.minor;
}

function configSchemaForDshVersion(dshVersion) {
  if (!isValidSemver(dshVersion)) return null;
  return compareSemver(dshVersion, PATCH_LAYER_EPOCH) >= 0
    ? CONFIG_SCHEMA.PATCH_LAYER
    : CONFIG_SCHEMA.SETTINGS_FILE;
}

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
    child.stdout.on('data', (d) => onData(d, false));
    child.stderr.on('data', (d) => onData(d, true));
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
  });
}

async function readManifestFromArchive(archivePath) {
  for (const member of [MANIFEST_MEMBER, `./${MANIFEST_MEMBER}`]) {
    const res = await runTarAsync(
      ['-xzOf', archivePath, '--occurrence=1', member],
      { timeoutMs: 120 * 1000, maxOutputBytes: 4 * 1024 * 1024 }
    );
    if (res.code === 0 && res.stdout.trim()) {
      try {
        return JSON.parse(res.stdout);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function listMembers(archivePath) {
  const res = await runTarAsync(['-tzf', archivePath], { timeoutMs: 300 * 1000, maxOutputBytes: 64 * 1024 * 1024 });
  if (res.code !== 0) throw new Error('无法列出归档成员: ' + (res.stderr || '未知错误'));
  return res.stdout.split('\n').map((s) => s.replace(/\s+$/, '')).filter(Boolean);
}

async function readMemberFromArchive(archivePath, member) {
  const res = await runTarAsync(
    ['-xzOf', archivePath, '--occurrence=1', member],
    { timeoutMs: 120 * 1000, maxOutputBytes: 8 * 1024 * 1024 }
  );
  return res.code === 0 ? res.stdout : null;
}

function canonicalJson(obj) {
  const walk = (v) => {
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

function buildManifest(ctx = {}) {
  const now = new Date();
  const dshVersion = ctx.dshVersion || null;
  const schemaVersion = ctx.schemaVersion
    ?? configSchemaForDshVersion(dshVersion)
    ?? null;
  const projectVersion = ctx.projectVersion || null;

  return {
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    generator: 'deepseek-harness-docker/gateway/backup-service',
    generatorVersion: projectVersion,
    dockerSuiteVersion: projectVersion,
    imageRevision: ctx.imageRevision || null,
    dshVersion,
    dshVersionSource: ctx.dshVersionSource || 'unknown',
    schemaVersion,
    configModel: CONFIG_MODEL_LABEL[schemaVersion] || 'unknown',
    backupType: ctx.backupType === 'config' ? 'config' : 'full',
    createdAt: now.toISOString(),
    createdAtEpochMs: now.getTime(),
    name: ctx.name || '',
    compatibilityRange: ctx.compatibilityRange || null,
    contents: ctx.contents || null,
    host: ctx.host || null,
    archive: ctx.archive || null,
    filesHash: {
      algorithm: 'sha256',
      manifestSelfHash: null,
      configTreeHash: null,
      fileCount: ctx.fileCount ?? null,
      totalBytes: ctx.totalBytes ?? null
    }
  };
}

function finalizeManifest(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.filesHash.manifestSelfHash = null;
  const hash = sha256Hex(canonicalJson(clone));
  manifest.filesHash.manifestSelfHash = hash;
  return manifest;
}

function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest 缺失或非对象' };
  const expect = manifest.filesHash && manifest.filesHash.manifestSelfHash;
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.filesHash.manifestSelfHash = null;
  const actual = sha256Hex(canonicalJson(clone));
  if (!expect) return { ok: false, reason: '缺少 manifestSelfHash' };
  return expect === actual ? { ok: true } : { ok: false, reason: 'manifestSelfHash 不匹配（内容被改动）' };
}

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
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
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

function sidecarIsFresh(sidecar, stat) {
  if (!sidecar || !sidecar.archive) return false;
  return Number(sidecar.archive.sizeBytes) === Number(stat.size)
    && Number(sidecar.archive.mtimeMs) === Math.floor(stat.mtimeMs);
}

/**
 * 依据归档成员结构推断旧快照的配置模型世代（兼容 `./.dsh/` 与 `.dsh/` 两种前缀）。
 */
function inferFromMembers(members, filename = '') {
  const normalized = (Array.isArray(members) ? members : []).map((m) =>
    String(m || '').replace(/^\.\//, '').replace(/\/+$/, '')
  );
  const set = new Set(normalized);
  const has = (p) => set.has(p);
  const anyUnder = (prefix) => normalized.some((m) => m === prefix || m.startsWith(prefix + '/'));

  const signals = [];
  const hasSettingsYaml = has('.dsh/settings.yaml');
  const hasSettingsImported = has('.dsh/settings.yaml.imported');
  const hasHomePatch = has('.dsh/cordis.patch.yml');
  const hasProfilePatch = normalized.some((m) => /^\.dsh\/profiles\/[^/]+\/cordis\.patch\.yml$/.test(m));
  const hasProfilesDir = anyUnder('.dsh/profiles');
  const hasSessions = anyUnder('.dsh/sessions');
  const hasCredentials = has('.dsh/.credentials.yaml');

  let schemaVersion = null;
  let confidence = 'low';

  if (hasHomePatch || hasProfilePatch || hasSettingsImported) {
    schemaVersion = CONFIG_SCHEMA.PATCH_LAYER;
    confidence = 'high';
    signals.push(
      hasSettingsImported
        ? '存在 settings.yaml.imported（0.1.7+ 一次性迁移产物）'
        : '存在 cordis.patch.yml（0.1.7+ 补丁层）'
    );
  } else if (hasSettingsYaml) {
    schemaVersion = CONFIG_SCHEMA.SETTINGS_FILE;
    confidence = 'high';
    signals.push('存在 settings.yaml 且无 cordis.patch.yml（0.1.6 及以前 settings-file 模型）');
  } else if (hasProfilesDir) {
    schemaVersion = null;
    confidence = 'low';
    signals.push('仅见 profiles/ 目录，无法判定世代');
  }

  const backupType = normalized.length > 0
    ? (hasSessions ? 'full' : 'config')
    : (filename.startsWith('dsh-config-') ? 'config' : 'full');

  return {
    inferred: true,
    confidence,
    signals,
    backupType,
    schemaVersion,
    configModel: CONFIG_MODEL_LABEL[schemaVersion] || 'unknown',
    legacySettingsWarning: schemaVersion === CONFIG_SCHEMA.SETTINGS_FILE,
    dshVersion: null,
    dshVersionRange: schemaVersion === CONFIG_SCHEMA.PATCH_LAYER ? `>=${PATCH_LAYER_EPOCH}`
      : schemaVersion === CONFIG_SCHEMA.SETTINGS_FILE ? `<${PATCH_LAYER_EPOCH}` : null,
    contents: {
      hasSettingsYaml,
      hasSettingsImported,
      hasCordisPatchYml: hasHomePatch || hasProfilePatch,
      hasProfilesDir,
      hasSessions,
      hasCredentials
    }
  };
}

async function inspectArchive(archivePath, opts = {}) {
  const filename = opts.filename || path.basename(archivePath);
  const snapshotsDir = opts.snapshotsDir || path.dirname(archivePath);
  const stat = fs.statSync(archivePath);
  const archive = { sizeBytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };

  if (!opts.force) {
    const sc = readSidecar(snapshotsDir, filename);
    if (sidecarIsFresh(sc, stat) && sc.meta) {
      return {
        filename,
        meta: sc.meta,
        metaSource: sc.metaSource || 'sidecar',
        confidence: sc.confidence || 'high',
        verified: Boolean(sc.verified),
        archive,
        fromCache: true
      };
    }
  }

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
  } catch {}

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

function assessCompatibility(snapshotMeta, current, opts = {}) {
  const snapVer = snapshotMeta && snapshotMeta.dshVersion;
  const snapSchema = snapshotMeta && snapshotMeta.schemaVersion;
  const curVer = current && current.dshVersion;
  const curSchema = (current && current.schemaVersion) || CONFIG_SCHEMA.PATCH_LAYER;
  const legacySettingsWarning = snapSchema === CONFIG_SCHEMA.SETTINGS_FILE;

  const messages = [];
  let level = 'ok';
  let code = 'EXACT_MATCH';
  const bump = (lv) => {
    const w = { ok: 0, info: 1, warning: 2, danger: 3, unknown: 2 };
    if ((w[lv] || 0) > (w[level] || 0)) level = lv;
  };

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

  // Schema 1（settings.yaml）旧世代快照还原到当前 Schema 2 系统：明确发出 warning 提醒
  if (legacySettingsWarning) {
    code = code === 'UNKNOWN_VERSION' ? code : 'SCHEMA_ERA_CROSS';
    bump('warning');
    messages.push({
      level: 'warning',
      kind: 'legacy-settings-schema',
      title: '旧版 settings.yaml 配置世代（Schema 1）',
      message: '该快照采用早期 settings.yaml 配置模型（DSH <= 0.1.6），还原后部分旧版设置项可能需要手动复核或重新配置。'
    });
  }

  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  if (isValidSemver(snapVer)) {
    const sev = { danger: 3, warning: 2, info: 1 };
    for (const rule of [...rules].sort((a, b) => (sev[b.level] || 0) - (sev[a.level] || 0))) {
      const pattern = rule && (rule.pattern || rule.range);
      if (pattern && matchSemverPattern(snapVer, pattern)) {
        // 对于快照还原（而非切换引擎），忽略 engine-unsupported 的切引擎拦截，保留警告提示
        if (rule.kind === 'engine-unsupported') continue;
        bump(rule.level === 'danger' ? 'danger' : rule.level === 'warning' ? 'warning' : 'info');
        messages.push({
          level: rule.level || 'warning',
          title: rule.title || '版本兼容性提示',
          message: rule.message || '',
          action: rule.action || ''
        });
        break;
      }
    }
  }

  const requiresAcknowledgement = level === 'warning' || level === 'danger' || level === 'unknown';
  const canProceed = level !== 'danger' || opts.allowDanger === true;

  return {
    level,
    code,
    legacySettingsWarning,
    snapshot: {
      dshVersion: snapVer || null,
      schemaVersion: snapSchema ?? null,
      configModel: CONFIG_MODEL_LABEL[snapSchema] || 'unknown',
      inferred: Boolean(snapshotMeta && snapshotMeta.inferred)
    },
    current: {
      dshVersion: curVer || null,
      schemaVersion: curSchema ?? null,
      configModel: CONFIG_MODEL_LABEL[curSchema] || 'unknown'
    },
    messages,
    requiresAcknowledgement,
    canProceed
  };
}

const YAML_STAMP_BEGIN = '# >>> dsh-snapshot-meta (auto-generated, do not edit) >>>';
const YAML_STAMP_END = '# <<< dsh-snapshot-meta <<<';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFileStamp(ctx = {}) {
  const schema = ctx.schemaVersion ?? configSchemaForDshVersion(ctx.dshVersion);
  return {
    dshVersion: ctx.dshVersion || null,
    schemaVersion: schema,
    configModel: CONFIG_MODEL_LABEL[schema] || 'unknown',
    dockerSuiteVersion: ctx.projectVersion || null,
    imageRevision: ctx.imageRevision || null,
    stampedAt: new Date().toISOString()
  };
}

function stampJsonConfig(obj, stamp) {
  if (!obj || typeof obj !== 'object') return obj;
  return { ...obj, _snapshotMeta: { ...buildFileStamp(stamp), note: 'DSH 套件写入的版本标识，供备份/还原兼容性判定使用' } };
}

function readJsonStamp(obj) {
  return obj && typeof obj === 'object' && obj._snapshotMeta ? obj._snapshotMeta : null;
}

function stripYamlStamp(text) {
  const re = new RegExp(`${escapeRe(YAML_STAMP_BEGIN)}[\\s\\S]*?${escapeRe(YAML_STAMP_END)}\\n?`, 'g');
  return String(text ?? '').replace(re, '');
}

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

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_MEMBER,
  MANIFEST_DIR_IN_DSH,
  CONFIG_SCHEMA,
  CONFIG_MODEL_LABEL,
  PATCH_LAYER_EPOCH,
  parseSemver,
  isValidSemver,
  compareSemver,
  sameMajorMinor,
  matchSemverPattern,
  configSchemaForDshVersion,
  runTarAsync,
  readManifestFromArchive,
  listMembers,
  readMemberFromArchive,
  canonicalJson,
  sha256Hex,
  buildManifest,
  finalizeManifest,
  verifyManifest,
  sidecarPath,
  readSidecar,
  writeSidecarAtomic,
  removeSidecar,
  sidecarIsFresh,
  inferFromMembers,
  inspectArchive,
  assessCompatibility,
  buildFileStamp,
  stampJsonConfig,
  readJsonStamp,
  stampYamlText,
  stripYamlStamp,
  readYamlStamp
};
