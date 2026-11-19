/**
 * npx 缓存自愈（Issue #18）。
 *
 * 背景：npx 的安装流程是「先解包 node_modules、最后才写 package.json 签名」。
 * 一旦在写签名之前被打断（慢网 + DSH 的 MCP 启动超时/重试，实测 139MB / 350KB/s 正好卡在超时边缘），
 * 缓存目录就永久停留在「有 node_modules、没有 package.json」的半成品状态：
 * 之后每次 npx 都会在 `PackageJson.load(installDir)` 处读根 package.json 失败（ENOENT），
 * 直接放弃 —— 于是 MCP 永久 disconnected，且 npm 没有补偿逻辑，永不自愈。
 *
 * 本模块做的事：
 *   1) 识别半成品目录，**先校验依赖闭包是否完整**（见下），完整才补写 npx 认可的签名；
 *   2) 闭包不完整时**绝不补签名**，而是整目录删除，让 npx 重新安装（tarball 已在 npm 的
 *      `_cacache` 里，重装不需要重新下载）；
 *   3) 空目录清理与活跃安装保护。
 *
 * 为什么「闭包不完整时绝不能补签名」（评审实测的反例）：
 *   npx 判断「是否已安装」看的是 `missingFromTree(spec, tree)` —— 只要**根包**在树里就认为命中，
 *   于是不会再跑 reify 补装。如果我们在依赖不全（或 `node_modules/.bin` 还没建）时补了签名，
 *   下一次 npx 会认为「已安装」直接执行 → `MODULE_NOT_FOUND` / `command not found`，
 *   而且**永久如此**（npx 再也不会重装）。这比原来的 ENOENT 更难排查，必须避免。
 *
 * 安全约束（与 npx 的锁协议对齐）：
 *   · npx 在 `_npx/<hash>/concurrency.lock` 上持有 mkdir 锁，心跳间隔 1s、60s 无心跳即视为 stale；
 *   · **该锁覆盖整个 reify（下载 + 解包）过程**（libnpmexec/lib/index.js:312-321 把 reify 包在 withLock 里），
 *     所以「下载很慢、node_modules 长时间没动静」的目录仍然持有新鲜锁 → 我们必然跳过，不会误删进行中的安装；
 *   · 因此存在新鲜锁（< 60s）时一律跳过，绝不与正在进行的安装抢写；
 *   · 静默期（默认 120s）是第二道保护，主要覆盖「锁已释放但签名尚未写」的短窗口与异常残留；
 *   · 写签名走「临时文件 + rename」原子替换，读者永远看不到半截 JSON。
 *
 * @module npx-cache
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileLevelGaps } = require('./installed-tree');

/** npx 锁目录名（libnpmexec/lib/with-lock.js） */
const LOCK_NAME = 'concurrency.lock';
/** npx 判定「锁已失效」的阈值：60s 无心跳 */
const LOCK_STALE_MS = 60 * 1000;

/** npm 缓存根目录：优先 NPM_CONFIG_CACHE，其次 ~/.npm */
function resolveNpmCacheDir(env = process.env) {
  const fromEnv = String(env.NPM_CONFIG_CACHE || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(env.HOME || os.homedir(), '.npm');
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

/**
 * 「最近一次活动」时间 = max(缓存目录 mtime, node_modules mtime)。
 * 两者都要看：npx 起手会先 mkdir（更新目录 mtime），随后往 node_modules 里解包（更新 node_modules mtime）；
 * 只看其一都会漏判——只看法目录会把「正在解包」当成静止，只看 node_modules 则保护不到空目录。
 */
function activityMtimeMs(dir) {
  return Math.max(dirMtimeMs(dir), dirMtimeMs(path.join(dir, 'node_modules')));
}

/** 锁是否「新鲜」（存在且在 stale 阈值内） */
function hasFreshLock(dir, now = Date.now()) {
  const lockPath = path.join(dir, LOCK_NAME);
  try {
    const st = fs.statSync(lockPath);
    return now - st.mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * 从 node_modules 反推顶层已安装包（含 @scope/name 形态）。
 * 只读每个包自己的 package.json，不解析依赖树，避免误判。
 */
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
    if (ent.name.startsWith('.')) continue; // .bin / .package-lock.json 等
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

/** 已声明的依赖是否都真的落在 node_modules 里（防止「有签名但内容是空的」） */
function missingDependencies(pkg, nodeModulesDir) {
  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  const missing = [];
  for (const name of deps) {
    if (!fs.existsSync(path.join(nodeModulesDir, name, 'package.json'))) missing.push(name);
  }
  return missing;
}

/** 取某个包声明的可执行名（bin 可能是字符串或对象；scoped 包默认取末段） */
function declaredBins(manifest) {
  if (!manifest) return [];
  const fallbackName = String(manifest.name || '').split('/').pop();
  if (typeof manifest.bin === 'string') return fallbackName ? [fallbackName] : [];
  if (manifest.bin && typeof manifest.bin === 'object') return Object.keys(manifest.bin);
  return [];
}

/**
 * 校验依赖闭包完整性 —— **补写签名前的强制闸门**。
 *
 * 三种缺口都要拦：
 *   1) package-lock.json 里声明了、磁盘上却没有的包（跳过 optional，避免 Linux 上的 fsevents 误报）；
 *   2) 直接依赖缺失；
 *   3) 声明了 bin 的包缺少 `node_modules/.bin/<name>` 链接 —— reify 的最后一步，最容易被中断。
 *
 * @returns {string[]} 缺口列表；空数组表示闭包完整
 */
function closureGaps(dir, lock, dependencies, warnings = []) {
  const gaps = [];
  const nodeModules = path.join(dir, 'node_modules');

  // 隐藏锁 node_modules/.package-lock.json 只作**诊断信息**，不再作为「未装完」的判据。
  // 实测证伪（npm 11，增量 reify 期间 50ms 轮询）：该文件在 reify 过程中始终存在（是上次安装留下的旧锁），
  // 并不能区分「装到一半」与「装完」；拿它当闸门只会在旧 npm 环境下反复删掉健康缓存。
  const hiddenLock = safeReadJson(path.join(nodeModules, '.package-lock.json'));

  // 真正的判据是**文件级**完整性：包目录存在 ≠ 包可用（解包逐文件写，被杀会留下缺入口的半成品）。
  // 只看目录会判健康 → 补签名 → 之后永久 MODULE_NOT_FOUND（子代理对抗验证的 P1）。
  for (const g of fileLevelGaps(nodeModules)) gaps.push('file:' + g);

  // 根 package-lock.json 丢失时，退回隐藏锁（同样含 packages 映射），
  // 这样「根锁被清掉 + 传递依赖缺失」也能被识别（评审 P2-2 的纵深防御）。
  let pkgs = (lock && lock.packages) || null;
  if (!pkgs) pkgs = (hiddenLock && hiddenLock.packages) || {};
  for (const key of Object.keys(pkgs)) {
    if (!key.startsWith('node_modules/')) continue;
    const meta = pkgs[key] || {};
    // optional 依赖按平台跳过安装（例如 Linux 上的 fsevents），缺失是正常的
    if (meta.optional) continue;
    if (!fs.existsSync(path.join(dir, key, 'package.json'))) gaps.push(key);
  }

  for (const name of Object.keys(dependencies || {})) {
    const manifest = safeReadJson(path.join(nodeModules, name, 'package.json'));
    if (!manifest) {
      if (!gaps.includes(name)) gaps.push(name);
      continue;
    }
    // 注意：.bin 链接缺失**不**作为删除依据。
    // 用户 .npmrc 里若设了 bin-links=false（或 bin 名冲突），健康缓存会被每 60s 删一次，
    // MCP 反而陷入反复重装。缺链接的表现是「command not found」，响亮且可重装，比误删安全得多。
    for (const binName of declaredBins(manifest)) {
      const linkPath = path.join(nodeModules, '.bin', binName);
      if (!fs.existsSync(linkPath)) warnings.push('bin:' + binName);
    }
  }

  return gaps;
}

/**
 * 优先从 package-lock.json 还原「用户真正请求的依赖」。
 *
 * 为什么不能只看 node_modules：npm 会把传递依赖提升（hoist）到顶层，
 * 直接扫描 node_modules 会把 lru-cache / yallist 这类 semver 的内部依赖
 * 误当成用户请求的直接依赖。package-lock.json 的 packages[""].dependencies
 * 恰好保存了 npx 当初写下的原始请求（含 ^ 范围），是更可靠的事实来源。
 * 该文件在「下载已完成、签名未写」的中断场景里通常已经落盘（实测如此）。
 *
 * @returns {{deps: Record<string,string>, versions: Record<string,string>, lock: object}|null}
 */
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

/**
 * 为一个半成品目录补写 package.json 签名。
 * @param {string} dir 缓存目录
 * @param {Record<string,string>} dependencies 依赖表（保留 npx 原始范围，如 "^7.6.0"）
 * @param {Array<{name: string, version: string}>} packages 解析出的包清单（用于 _npx.packages）
 * @param {{_onTempWritten?: Function}} [hooks] 测试钩子：临时文件写好后、rename 之前触发
 * @returns {{ok: boolean, error?: string, packages?: Array<{name: string, version: string}>}}
 */
function writeSignature(dir, dependencies, packages, hooks = {}) {
  // _npx.packages 只登记版本已知的包；版本未知时不臆造（该字段仅 npm cache ls 展示用）
  const known = packages.filter((p) => p && p.name && p.version);
  const payload = {
    name: 'npx-cache-' + path.basename(dir),
    version: '1.0.0',
    private: true,
    dependencies,
    // npx 自己会维护这个字段（libnpmexec/lib/index.js: pkgJson.update({ _npx: { packages } })）
    _npx: { packages: known.map((p) => p.name + '@' + p.version) }
  };
  const target = path.join(dir, 'package.json');
  cleanStaleTemps(target);
  const tmp = target + '.heal-' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o644 });
    if (typeof hooks._onTempWritten === 'function') hooks._onTempWritten(tmp, target);
    fs.renameSync(tmp, target); // 原子替换：任何时刻读者都看不到半截 JSON
    return { ok: true, packages: known };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: e.message };
  }
}

/** 清理历史遗留的 *.heal-*.tmp（进程被杀后不同 pid 的残留会一直堆积） */
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

/** 目录内除锁以外是否完全为空（可安全清理的垃圾） */
function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n !== LOCK_NAME).length === 0;
  } catch {
    return false;
  }
}

/**
 * 扫描并自愈 npx 缓存。
 *
 * @param {object} [opts]
 * @param {string} [opts.cacheDir] npm 缓存根目录（默认 ~/.npm）
 * @param {boolean} [opts.dryRun] 只诊断不落盘
 * @param {number} [opts.quietMs] 目录需静默多久才判定为「已中断」（运行期默认 120s；启动时传 0）
 * @param {number} [opts.now] 注入当前时间（测试用）
 * @param {Function} [opts._onTempWritten] 测试钩子（透传给 writeSignature）
 * @returns {{cacheDir: string, scanned: number, repaired: number, healthy: number, removed: number,
 *            skipped: number, errors: number, actions: Array<object>}}
 */
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
    return result; // 没有 npx 缓存，直接返回
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

    // 1) 正在安装（锁新鲜）→ 绝不插手
    if (hasFreshLock(dir, now)) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'active-lock' });
      continue;
    }

    const nodeModules = path.join(dir, 'node_modules');
    const hasNodeModules = fs.existsSync(nodeModules);

    // 2) 静默期判定：安装可能仍在进行（只是还没写签名）
    //    注意：空目录清理也必须受此保护——npx 会先 mkdir 再取锁，存在极短的空窗
    const quiet = quietMs > 0 && now - activityMtimeMs(dir) < quietMs;

    // 3) 空目录：**不删**。npm 的 mkdir(installDir) 与取锁之间还隔着 registry 元数据解析
    //    与交互确认（libnpmexec/lib/index.js:264-310），这段窗口在慢镜像源/等人回车时可达数分钟，
    //    删掉正在安装的目录风险远大于收益（空目录对 npx 完全无害，mkdir 是幂等的）。
    if (!hasNodeModules && isEmptyDir(dir)) {
      result.skipped++;
      result.actions.push({ dir, action: 'skip', reason: 'empty' });
      continue;
    }

    // 4) 没有 node_modules → 无从修复，留给 npx 自己重装
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

    // 5) 还原依赖表：已有签名优先（它就是 npx 自己写的），否则从 lock 推，最后回退扫描
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
      // 再退一步：隐藏锁里记录了本次 reify 的根依赖（packages[""].dependencies），
      // 比扫描 node_modules 更准确（扫描会把被 hoist 的传递依赖误当成直接依赖）。
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

    // 6) 完整性闸门（P0）：闭包不完整时补签名只会制造「假已安装」，必须整目录删除让 npx 重装
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

    // 7) 已有合法签名且闭包完整 → 健康
    if (existing && existing.dependencies && Object.keys(existing.dependencies).length > 0) {
      result.healthy++;
      result.actions.push({ dir, action: 'ok', warnings: warnings.length ? warnings.slice(0, 3) : undefined });
      continue;
    }

    // 8) 半成品但闭包完整 → 补写签名
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

  // 真实变更后立刻失效状态缓存：避免「刚修好却仍显示 broken」
  if (!dryRun && (result.repaired > 0 || result.removed > 0)) invalidateStatusCache(cacheDir);

  return result;
}

/** 汇总目录体积（用于状态展示，避免用户无感知地撑爆磁盘） */
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

/** 状态缓存（按 cacheDir 键化，TTL 60s）：避免每次查状态都同步遍历缓存目录阻塞事件循环 */
const statusCache = new Map();
const STATUS_TTL_MS = 60 * 1000;

/** 任何真实修复/清理后必须失效缓存，否则会出现「刚修好却仍显示 broken」（评审 P2-1） */
function invalidateStatusCache(cacheDir) {
  if (cacheDir) statusCache.delete(cacheDir);
  else statusCache.clear();
}

/** 只读状态：不修复，供管理后台展示 */
function getNpxCacheStatus(opts = {}) {
  const cacheDir = opts.cacheDir || resolveNpmCacheDir();
  const useCache = opts.useCache !== false;
  const cached = statusCache.get(cacheDir);
  if (useCache && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return cached.value;
  }
  const npxRoot = path.join(cacheDir, '_npx');
  const scan = healNpxCache({ cacheDir, dryRun: true, quietMs: 0 });
  // incomplete 只统计「闭包不完整被删」的目录；空目录清理单独计数（评审 P2-4）
  const isIncomplete = (a) => (a.action === 'remove' || a.action === 'would-remove') &&
    String(a.reason || '').startsWith('incomplete:');
  const isEmpty = (a) => (a.action === 'remove' || a.action === 'would-remove') &&
    String(a.reason || '') === 'empty';
  const value = {
    cacheDir,
    exists: fs.existsSync(npxRoot),
    dirs: scan.scanned,
    healthy: scan.healthy,
    broken: scan.repaired,
    incomplete: scan.actions.filter(isIncomplete).length,
    emptyRemoved: scan.actions.filter(isEmpty).length,
    // 只统计 _npx（不含 _cacache）：后者可达数万文件，遍历成本高且与 MCP 无关
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
