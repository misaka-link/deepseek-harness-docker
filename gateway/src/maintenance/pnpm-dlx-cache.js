'use strict';
/**
 * pnpm dlx 缓存自愈（适配非 root $HOME 与 paths.getDshHome()）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../core/paths');
const { fileLevelGaps } = require('./installed-tree');

function resolvePnpmCacheDir(env = process.env) {
  const xdg = String(env.XDG_CACHE_HOME || '').trim();
  if (xdg) return path.join(xdg, 'pnpm');
  const baseHome = String(env.HOME || '').trim() || paths.getDshHome() || os.homedir();
  return path.join(baseHome, '.cache', 'pnpm');
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function activityMtimeMs(buildDir) {
  return Math.max(mtimeMs(buildDir), mtimeMs(path.join(buildDir, 'node_modules')));
}

function readDepsFromLock(lockText) {
  if (!lockText) return null;
  const lines = lockText.split('\n');
  let inImporters = false;
  let inRoot = false;
  let inDeps = false;
  const deps = {};
  let current = null;
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) { inImporters = true; continue; }
    if (inImporters && /^packages:\s*$/.test(line)) break;
    if (!inImporters) continue;
    if (/^  \.:\s*$/.test(line)) { inRoot = true; continue; }
    if (!inRoot) continue;
    if (/^    dependencies:\s*$/.test(line)) { inDeps = true; continue; }
    if (inDeps) {
      const m6 = line.match(/^      ([^:]+):\s*$/);
      if (m6) { current = m6[1].trim().replace(/^['"]|['"]$/g, ''); deps[current] = ''; continue; }
      const mSpec = line.match(/^        specifier:\s*(.+?)\s*$/);
      if (mSpec && current) { deps[current] = mSpec[1].replace(/^['"]|['"]$/g, ''); continue; }
      if (/^    [a-zA-Z]/.test(line)) { inDeps = false; inRoot = false; }
    }
  }
  return Object.keys(deps).length > 0 ? deps : null;
}

function listInstalledPackages(nodeModulesDir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true }); } catch { return out; }
  const collect = (pkgDir) => {
    const pkg = safeReadJson(path.join(pkgDir, 'package.json'));
    if (pkg && pkg.name && pkg.version) out.push({ name: String(pkg.name), version: String(pkg.version), manifest: pkg });
  };
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (ent.name.startsWith('.')) continue;
    if (ent.name.startsWith('@')) {
      let scoped = [];
      try { scoped = fs.readdirSync(path.join(nodeModulesDir, ent.name), { withFileTypes: true }); } catch { continue; }
      for (const s of scoped) collect(path.join(nodeModulesDir, ent.name, s.name));
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

function hasActivePnpmProcess() {
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch { continue; }
    if (!cmd) continue;
    const parts = cmd.split('\0').filter(Boolean);
    if (parts.slice(0, 2).some((p) => /(^|\/)(pnpm|pnpx|pnx)(\.c?js)?$/.test(p))) return true;
  }
  return false;
}

function closureGaps(buildDir, dependencies, warnings = []) {
  const gaps = [];
  const nodeModules = path.join(buildDir, 'node_modules');
  for (const name of Object.keys(dependencies || {})) {
    const manifest = safeReadJson(path.join(nodeModules, name, 'package.json'));
    if (!manifest) { gaps.push(name); continue; }
    for (const binName of declaredBins(manifest)) {
      if (!fs.existsSync(path.join(nodeModules, '.bin', binName))) warnings.push('bin:' + binName);
    }
  }
  for (const g of fileLevelGaps(nodeModules)) gaps.push('file:' + g);
  return gaps;
}

function writeManifest(buildDir, dependencies, hooks = {}) {
  const payload = { name: 'dlx', version: '0.0.0', dependencies };
  const target = path.join(buildDir, 'package.json');
  const tmp = target + '.heal-' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o644 });
    if (typeof hooks._onTempWritten === 'function') hooks._onTempWritten(tmp, target);
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: e.message };
  }
}

function healPnpmDlxCache(opts = {}) {
  const cacheRoot = opts.cacheDir || resolvePnpmCacheDir();
  const dlxRoot = path.join(cacheRoot, 'dlx');
  const dryRun = Boolean(opts.dryRun);
  const quietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : 0;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const result = { cacheDir: cacheRoot, scanned: 0, repaired: 0, healthy: 0, removed: 0, skipped: 0, errors: 0, actions: [] };

  let hashes = [];
  try { hashes = fs.readdirSync(dlxRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return result; }

  const pnpmActive = hasActivePnpmProcess();

  const removeDir = (dir, reason) => {
    if (dryRun) { result.removed++; result.actions.push({ dir, action: 'would-remove', reason }); return; }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed++;
      result.actions.push({ dir, action: 'remove', reason });
    } catch (e) {
      result.errors++;
      result.actions.push({ dir, action: 'error', reason: e.message });
    }
  };

  for (const h of hashes) {
    const hashDir = path.join(dlxRoot, h.name);
    let builds = [];
    try { builds = fs.readdirSync(hashDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }

    let pkgTarget = null;
    try { pkgTarget = path.resolve(hashDir, fs.readlinkSync(path.join(hashDir, 'pkg'))); } catch {}

    for (const b of builds) {
      const buildDir = path.join(hashDir, b.name);
      result.scanned++;

      if (pnpmActive) {
        result.skipped++;
        result.actions.push({ dir: buildDir, action: 'skip', reason: 'pnpm-active' });
        continue;
      }

      if (pkgTarget && buildDir !== pkgTarget) {
        if (quietMs > 0 && now - activityMtimeMs(buildDir) < quietMs) {
          result.skipped++;
          result.actions.push({ dir: buildDir, action: 'skip', reason: 'orphan-recently-active' });
          continue;
        }
        removeDir(buildDir, 'orphan(未被 pkg 指向)');
        continue;
      }

      const nodeModules = path.join(buildDir, 'node_modules');
      const hasNodeModules = fs.existsSync(nodeModules);

      if (!hasNodeModules) {
        let isEmpty = false;
        try { isEmpty = fs.readdirSync(buildDir).length === 0; } catch { result.errors++; continue; }
        if (isEmpty) {
          if (quietMs > 0 && now - activityMtimeMs(buildDir) < quietMs) { result.skipped++; continue; }
          removeDir(buildDir, 'empty');
          continue;
        }
        result.skipped++;
        result.actions.push({ dir: buildDir, action: 'skip', reason: 'no-node-modules' });
        continue;
      }

      if (quietMs > 0 && now - activityMtimeMs(buildDir) < quietMs) {
        result.skipped++;
        result.actions.push({ dir: buildDir, action: 'skip', reason: 'recently-active' });
        continue;
      }

      const existing = safeReadJson(path.join(buildDir, 'package.json'));
      const lockText = (() => { try { return fs.readFileSync(path.join(buildDir, 'pnpm-lock.yaml'), 'utf8'); } catch { return ''; } })();
      let dependencies;
      let source;
      if (existing && existing.dependencies && Object.keys(existing.dependencies).length > 0) {
        dependencies = existing.dependencies;
        source = 'package.json';
      } else {
        const fromLock = readDepsFromLock(lockText);
        if (fromLock) {
          dependencies = fromLock;
          source = 'pnpm-lock.yaml';
        } else {
          const installed = listInstalledPackages(nodeModules);
          if (installed.length === 0) {
            result.skipped++;
            result.actions.push({ dir: buildDir, action: 'skip', reason: 'no-installed-packages' });
            continue;
          }
          dependencies = {};
          for (const p of installed) dependencies[p.name] = p.version;
          source = 'node_modules';
        }
      }

      const warnings = [];
      const gaps = closureGaps(buildDir, dependencies, warnings);
      if (warnings.length > 0) {
        result.warnings = (result.warnings || 0) + warnings.length;
        for (const w of warnings.slice(0, 3)) console.warn('[pnpm-dlx] 非致命告警（不删除）:', buildDir, w);
      }
      if (gaps.length > 0) {
        removeDir(buildDir, 'incomplete:' + gaps.slice(0, 5).join(',') + (gaps.length > 5 ? ',…' : ''));
        continue;
      }

      if (existing && existing.dependencies && Object.keys(existing.dependencies).length > 0) {
        result.healthy++;
        result.actions.push({ dir: buildDir, action: 'ok', warnings: warnings.length ? warnings.slice(0, 3) : undefined });
        continue;
      }

      if (dryRun) {
        result.repaired++;
        result.actions.push({ dir: buildDir, action: 'would-repair', source, dependencies });
        continue;
      }
      const w = writeManifest(buildDir, dependencies, { _onTempWritten: opts._onTempWritten });
      if (w.ok) {
        result.repaired++;
        result.actions.push({ dir: buildDir, action: 'repaired', source, dependencies });
      } else {
        result.errors++;
        result.actions.push({ dir: buildDir, action: 'error', reason: w.error });
      }
    }
  }

  return result;
}

module.exports = {
  resolvePnpmCacheDir,
  readDepsFromLock,
  listInstalledPackages,
  closureGaps,
  healPnpmDlxCache
};
