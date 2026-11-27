'use strict';
/**
 * npx 缓存自愈（适配非 root $HOME 与 paths.getDshHome()）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../core/paths');
const { fileLevelGaps } = require('./installed-tree');

const LOCK_NAME = 'concurrency.lock';
const LOCK_STALE_MS = 60 * 1000;

function resolveNpmCacheDir(env = process.env) {
  const fromEnv = String(env.NPM_CONFIG_CACHE || '').trim();
  if (fromEnv) return fromEnv;
  const baseHome = String(env.HOME || '').trim() || paths.getDshHome() || os.homedir();
  return path.join(baseHome, '.npm');
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dirMtimeMs(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function activityMtimeMs(dir) {
  return Math.max(dirMtimeMs(dir), dirMtimeMs(path.join(dir, 'node_modules')));
}

function hasFreshLock(dir, now = Date.now()) {
  const lockPath = path.join(dir, LOCK_NAME);
  try {
    const st = fs.statSync(lockPath);
    return now - st.mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function listInstalledPackages(nodeModulesDir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return out;
  }

  const collect = (pkgDir) => {
    const pkg = safeReadJson(path.join(pkgDir, 'package.json'));
    if (!pkg || !pkg.name || !pkg.version) return;
    out.push({ name: String(pkg.name), version: String(pkg.version) });
  };

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    if (ent.name.startsWith('@')) {
      let scoped = [];
      try {
        scoped = fs.readdirSync(path.join(nodeModulesDir, ent.name), { withFileTypes: true });
      } catch { continue; }
      for (const s of scoped) {
        if (s.isDirectory()) collect(path.join(nodeModulesDir, ent.name, s.name));
      }
      continue;
    }
    collect(path.join(nodeModulesDir, ent.name));
  }
  return out;
}

function declaredBins(manifest) {
  if (!manifest) return [];
  const fallbackName = String(manifest.name || '').split('/').pop();
  if (typeof manifest.bin === 'string') return fallbackName ? [fallbackName] : [];
  if (manifest.bin && typeof manifest.bin === 'object') return Object.keys(manifest.bin);
  return [];
}

function closureGaps(dir, lock, dependencies, warnings = []) {
  const gaps = [];
  const nodeModules = path.join(dir, 'node_modules');
  const hiddenLock = safeReadJson(path.join(nodeModules, '.package-lock.json'));

  for (const g of fileLevelGaps(nodeModules)) gaps.push('file:' + g);

  let pkgs = (lock && lock.packages) || null;
  if (!pkgs) pkgs = (hiddenLock && hiddenLock.packages) || {};
  for (const key of Object.keys(pkgs)) {
    if (!key.startsWith('node_modules/')) continue;
    const meta = pkgs[key] || {};
    if (meta.optional) continue;
    if (!fs.existsSync(path.join(dir, key, 'package.json'))) gaps.push(key);
  }

  for (const name of Object.keys(dependencies || {})) {
    const manifest = safeReadJson(path.join(nodeModules, name, 'package.json'));
    if (!manifest) {
      if (!gaps.includes(name)) gaps.push(name);
      continue;
    }
    for (const binName of declaredBins(manifest)) {
      const linkPath = path.join(nodeModules, '.bin', binName);
      if (!fs.existsSync(linkPath)) warnings.push('bin:' + binName);
    }
  }

  return gaps;
}

function readRequestedDepsFromLock(dir) {
  const lock = safeReadJson(path.join(dir, 'package-lock.json'));
  const root = lock && lock.packages && lock.packages[''];
  const deps = root && root.dependencies;
  if (!deps || typeof deps !== 'object' || Object.keys(deps).length === 0) return null;
  const versions = {};
  for (const name of Object.keys(deps)) {
    const node = lock.packages['node_modules/' + name];
    if (node && node.version) versions[name] = String(node.version);
  }
  return { deps, versions, lock };
}

function cleanStaleTemps(target) {
  const dir = path.dirname(target);
  const base = path.basename(target) + '.heal-';
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(base) && name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(dir, name)); } catch {}
      }
    }
  } catch {}
}

function writeSignature(dir, dependencies, packages, hooks = {}) {
  const known = packages.filter((p) => p && p.name && p.version);
  const payload = {
    name: 'npx-cache-' + path.basename(dir),
    version: '1.0.0',
    private: true,
    dependencies,
    _npx: { packages: known.map((p) => p.name + '@' + p.version) }
  };
  const target = path.join(dir, 'package.json');
  cleanStaleTemps(target);
  const tmp = target + '.heal-' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o644 });
    if (typeof hooks._onTempWritten === 'function') hooks._onTempWritten(tmp, target);
    fs.renameSync(tmp, target);
    return { ok: true, packages: known };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: e.message };
  }
}

function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n !== LOCK_NAME).length === 0;
  } catch {
    return false;
  }
}

function healNpxCache(opts = {}) {
  const cacheDir = opts.cacheDir || resolveNpmCacheDir();
  const dryRun = Boolean(opts.dryRun);
  const quietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : 0;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const npxRoot = path.join(cacheDir, '_npx');

  const result = {
    cacheDir,
    scanned: 0,
    repaired: 0,
    healthy: 0,
    removed: 0,
    skipped: 0,
    errors: 0,
    actions: []
  };

  let entries = [];
  try {
    entries = fs.readdirSync(npxRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const removeDir = (dir, reason) => {
    if (dryRun) {
      result.removed++;
      result.actions.push({ dir, action: 'would-remove', reason });
      return;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed++;
      result.actions.push({ dir, action: 'remove', reason });
    } catch (e) {
      result.errors++;
      result.actions.push({ dir, action: 'error', reason: e.message });
    }
  };

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(npxRoot, ent.name);
    result.scanned++;

    if (hasFreshLock(dir, now)) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'active-lock' });
      continue;
    }

    const nodeModules = path.join(dir, 'node_modules');
    const hasNodeModules = fs.existsSync(nodeModules);
    const quiet = quietMs > 0 && now - activityMtimeMs(dir) < quietMs;

    if (!hasNodeModules && isEmptyDir(dir)) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'empty' });
      continue;
    }

    if (!hasNodeModules) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'no-node-modules' });
      continue;
    }

    if (quiet) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'recently-active' });
      continue;
    }

    const existing = safeReadJson(path.join(dir, 'package.json'));
    const fromLock = readRequestedDepsFromLock(dir);
    let dependencies;
    let packages;
    let source;
    if (existing && existing.dependencies && Object.keys(existing.dependencies).length > 0) {
      dependencies = existing.dependencies;
      packages = listInstalledPackages(nodeModules);
      source = 'package.json';
    } else if (fromLock) {
      dependencies = fromLock.deps;
      packages = Object.keys(fromLock.deps).map((name) => ({
        name,
        version: fromLock.versions[name] || ''
      }));
      source = 'package-lock.json';
    } else {
      const hidden = safeReadJson(path.join(nodeModules, '.package-lock.json'));
      const hiddenRoot = hidden && hidden.packages && hidden.packages[''] && hidden.packages[''].dependencies;
      if (hiddenRoot && Object.keys(hiddenRoot).length > 0) {
        dependencies = hiddenRoot;
        packages = Object.keys(hiddenRoot).map((name) => {
          const node = hidden.packages['node_modules/' + name];
          return { name, version: node && node.version ? String(node.version) : '' };
        });
        source = 'node_modules/.package-lock.json';
      } else {
        packages = listInstalledPackages(nodeModules);
        dependencies = {};
        for (const p of packages) dependencies[p.name] = p.version;
        source = 'node_modules';
      }
    }

    if (Object.keys(dependencies).length === 0) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'no-installed-packages' });
      continue;
    }

    const warnings = [];
    const gaps = closureGaps(dir, fromLock && fromLock.lock, dependencies, warnings);
    if (warnings.length > 0) {
      result.warnings = (result.warnings || 0) + warnings.length;
      for (const w of warnings.slice(0, 3)) console.warn('[npx-cache] 非致命告警（不删除）:', dir, w);
    }
    if (gaps.length > 0) {
      removeDir(dir, 'incomplete:' + gaps.slice(0, 5).join(',') + (gaps.length > 5 ? ',…' : ''));
      continue;
    }

    if (existing && existing.dependencies && Object.keys(existing.dependencies).length > 0) {
      result.healthy++;
      result.actions.push({ dir, action: 'ok', warnings: warnings.length ? warnings.slice(0, 3) : undefined });
      continue;
    }

    if (dryRun) {
      result.repaired++;
      result.actions.push({ dir, action: 'would-repair', source, dependencies, packages });
      continue;
    }
    const w = writeSignature(dir, dependencies, packages, { _onTempWritten: opts._onTempWritten });
    if (w.ok) {
      result.repaired++;
      result.actions.push({ dir, action: 'repaired', source, dependencies, packages: w.packages });
    } else {
      result.errors++;
      result.actions.push({ dir, action: 'error', reason: w.error });
    }
  }

  if (!dryRun && (result.repaired > 0 || result.removed > 0)) invalidateStatusCache(cacheDir);
  return result;
}

function dirSizeBytes(dir) {
  let total = 0;
  const walk = (p, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const fp = path.join(p, ent.name);
      try {
        if (ent.isDirectory()) walk(fp, depth + 1);
        else total += fs.statSync(fp).size;
      } catch {}
    }
  };
  walk(dir, 0);
  return total;
}

const statusCache = new Map();
const STATUS_TTL_MS = 60 * 1000;

function invalidateStatusCache(cacheDir) {
  if (cacheDir) statusCache.delete(cacheDir);
  else statusCache.clear();
}

function getNpxCacheStatus(opts = {}) {
  const cacheDir = opts.cacheDir || resolveNpmCacheDir();
  const useCache = opts.useCache !== false;
  const cached = statusCache.get(cacheDir);
  if (useCache && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return cached.value;
  }
  const npxRoot = path.join(cacheDir, '_npx');
  const scan = healNpxCache({ cacheDir, dryRun: true, quietMs: 0 });
  const isIncomplete = (a) => (a.action === 'remove' || a.action === 'would-remove')
    && String(a.reason || '').startsWith('incomplete:');
  const isEmpty = (a) => (a.action === 'remove' || a.action === 'would-remove')
    && String(a.reason || '') === 'empty';
  const value = {
    cacheDir,
    exists: fs.existsSync(npxRoot),
    dirs: scan.scanned,
    healthy: scan.healthy,
    broken: scan.repaired,
    incomplete: scan.actions.filter(isIncomplete).length,
    emptyRemoved: scan.actions.filter(isEmpty).length,
    sizeBytes: fs.existsSync(npxRoot) ? dirSizeBytes(npxRoot) : 0,
    actions: scan.actions
  };
  if (useCache) statusCache.set(cacheDir, { at: Date.now(), value });
  return value;
}

module.exports = {
  LOCK_NAME,
  LOCK_STALE_MS,
  resolveNpmCacheDir,
  listInstalledPackages,
  closureGaps,
  declaredBins,
  healNpxCache,
  getNpxCacheStatus,
  invalidateStatusCache,
  dirSizeBytes
};
