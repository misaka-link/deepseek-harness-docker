/**
 * pnpm dlx 缓存自愈（Issue #18 同款问题）。
 *
 * 与 npx 完全同源的故障模式：pnpm 先把包装进 `<cache>/pnpm/dlx/<hash>/<build>/node_modules`，
 * **最后**才写 `<build>/package.json` 清单。中途被打断（慢网 / MCP 启动超时 / 进程被杀）后，
 * 目录永久停在「有 node_modules 与 pnpm-lock.yaml、没有 package.json」，之后每次 dlx 都报：
 *
 *   ERR_PNPM_CLI_DLX_READ_MANIFEST  × Failed to read the installed manifest at
 *   .../dlx/<hash>/<build>/package.json: No such file or directory (os error 2)
 *
 * 实测（pnpm 12.5.1）：**不会自愈**，重跑依旧失败。
 * 镜像内 `pnpx` / `pnx` / `pn` 都存在（/usr/local/bin 软链），用户完全可能用它配 MCP，
 * 因此与 npx 一并自愈。
 *
 * 修复方式与 npx 一致：校验依赖闭包 → 完整则按 pnpm 自己的格式补写清单（`{"name":"dlx","version":"0.0.0",...}`），
 * 不完整则整目录删除让 pnpm 重装。绝不触碰 `node_modules` 以外的内容。
 *
 * @module pnpm-dlx-cache
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileLevelGaps } = require('./installed-tree');

/** pnpm 的缓存根：XDG_CACHE_HOME || ~/.cache */
function resolvePnpmCacheDir(env = process.env) {
  const xdg = String(env.XDG_CACHE_HOME || '').trim();
  if (xdg) return path.join(xdg, 'pnpm');
  return path.join(env.HOME || os.homedir(), '.cache', 'pnpm');
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** 「最近活动」= max(构建目录, node_modules) */
function activityMtimeMs(buildDir) {
  return Math.max(mtimeMs(buildDir), mtimeMs(path.join(buildDir, 'node_modules')));
}

/**
 * 从 pnpm-lock.yaml 的 importers["."].dependencies 还原用户请求的依赖。
 * 只解析该固定片段（pnpm v9 lock 格式），解析失败返回 null 由调用方回退扫描 node_modules。
 * @returns {Record<string,string>|null}
 */
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

/** 列出 node_modules 顶层包（pnpm 用符号链接，readFileSync 会自动跟随） */
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

/**
 * 依赖闭包校验：直接依赖存在 + 声明了 bin 的包有对应 .bin 链接。
 * @returns {string[]} 缺口列表
 */
/**
 * pnpm **没有** npm 那样的 concurrency.lock 协议，只能靠「有没有活跃 pnpm 进程」判断。
 * 慢网下 node_modules 已建但解包停滞超过静默期，若此时按「闭包不完整」删目录，
 * 会把正在进行的安装连根拔掉（子代理对抗审查的 P1-3）。
 */
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
    // 只认「argv[0] 或 argv[1] 是 pnpm/pnpx/pnx」的进程，避免误伤 node 自身
    if (parts.slice(0, 2).some((p) => /(^|\/)(pnpm|pnpx|pnx)(\.c?js)?$/.test(p))) return true;
  }
  return false;
}

function closureGaps(buildDir, dependencies, warnings = []) {
  const gaps = [];
  const nodeModules = path.join(buildDir, 'node_modules');
  // 注：pnpm 的 node_modules/.modules.yaml 不是必需品（实测缺失也能正常运行），
  // 因此只作为诊断信息，不参与「是否删除」的判定，避免白丢缓存。
  for (const name of Object.keys(dependencies || {})) {
    const manifest = safeReadJson(path.join(nodeModules, name, 'package.json'));
    if (!manifest) { gaps.push(name); continue; }
    // .bin 链接缺失不删除整目录（同 npx 侧：bin-links=false 会导致健康缓存被反复误删）
    for (const binName of declaredBins(manifest)) {
      if (!fs.existsSync(path.join(nodeModules, '.bin', binName))) warnings.push('bin:' + binName);
    }
  }
  // 文件级完整性：目录在 ≠ 包可用（解包中断会留下缺入口的半成品，补清单只会让坏目录永久合法化）
  for (const g of fileLevelGaps(nodeModules)) gaps.push('file:' + g);
  return gaps;
}

/** 按 pnpm 自己的格式补写清单（实测格式：{"name":"dlx","version":"0.0.0","dependencies":{...}}） */
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

/**
 * 扫描并自愈 pnpm dlx 缓存。
 * @param {{cacheDir?: string, dryRun?: boolean, quietMs?: number, now?: number, _onTempWritten?: Function}} [opts]
 */
function healPnpmDlxCache(opts = {}) {
  const cacheRoot = opts.cacheDir || resolvePnpmCacheDir();
  const dlxRoot = path.join(cacheRoot, 'dlx');
  const dryRun = Boolean(opts.dryRun);
  const quietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : 0;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const result = { cacheDir: cacheRoot, scanned: 0, repaired: 0, healthy: 0, removed: 0, skipped: 0, errors: 0, actions: [] };

  let hashes = [];
  try { hashes = fs.readdirSync(dlxRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return result; }

  // pnpm 没有锁协议：只要检测到活跃 pnpm 进程，本轮一律只读不动手（宁可晚一轮，也不删正在进行的安装）
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

    // pnpm 用 <hash>/pkg 这个软链指向「当前生效的 build」。被中断过的 hash 会累积多个 build 目录，
    // 除 pkg 指向的那个之外都是孤儿（实测同一 hash 可堆到 5 个目录 / 22MB 且永不回收）。
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

      // 孤儿回收：仅在 pkg 指向明确、且该目录已静默时删除，绝不碰正在安装的目录
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
        // 目录可能在扫描途中被并发删除：读失败按「跳过」处理，不能中断整轮扫描
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
