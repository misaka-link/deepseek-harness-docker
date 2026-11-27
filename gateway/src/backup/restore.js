'use strict';
/**
 * restore.js — 100% 向后兼容的快照安全还原管线。
 *
 * 保留全部历史快照兼容能力 + v1.0.0 三项关键修复：
 *   1) keep-live 清单补齐 `.internal-api-token`（与 `gateway.config.json`、`.session_secret` 一起保留）；
 *   2) `plugins-state.json` 还原策略：快照不含该文件则保留现网，含该文件则合并 `known: live.known ∪ snap.known`，
 *      通过 `scripts/lib/plugin-state.cjs` 单写者落盘，杜绝已卸载/停用插件复活；
 *   3) 还原后对全部敏感文件（.credentials.yaml / .session_secret / .internal-api-token / gateway.config.json）
 *      统一收紧权限至 0600，并在依赖缺失时通过 pnpm 自动补全。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const paths = require('../core/paths');
const CAPABILITIES = require('../core/capabilities');
const {
  DATA_ENTRIES,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  hasPigz,
  runTarAsync,
  validateArchiveMembers
} = require('./archive-validate');
const { repairEscapingRelativeLinks } = require('./legacy-links');
const { state, resolveSnapshotLocation } = require('./state');
const {
  readPluginState,
  writePluginState,
  mergePluginStates
} = require('../../../scripts/lib/plugin-state.cjs');

const KEEP_LIVE_FILES = ['gateway.config.json', '.session_secret', '.internal-api-token'];
const SENSITIVE_MODE_600_FILES = ['gateway.config.json', '.session_secret', '.internal-api-token', '.credentials.yaml'];

function needsPnpmInstall(webProfileDir) {
  const pkgPath = path.join(webProfileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const nmDir = path.join(webProfileDir, 'node_modules');
  if (!fs.existsSync(nmDir)) return true;
  let nmEntries = [];
  try { nmEntries = fs.readdirSync(nmDir); } catch { return true; }
  if (nmEntries.length === 0) return true;

  // 检查 package.json 中声明的非 link: 依赖是否已落在 node_modules 内
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('link:')) continue;
      if (!fs.existsSync(path.join(nmDir, depName))) {
        return true;
      }
    }
  } catch {}
  return false;
}

function resolveScriptPath(rel) {
  const candidates = [
    path.join('/app/scripts', rel),
    path.join(__dirname, '../../../scripts', rel)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function restoreBackup(filename, dshManager, opts = {}) {
  if (state.activeTask) {
    const err = new Error(`当前正在执行 ${state.activeTask.label} 操作，请稍候再试`);
    err.errorCode = 'SNAPSHOT_BUSY';
    err.code = 'BUSY';
    throw err;
  }

  const mode = (opts && opts.mode) ? opts.mode : 'full';
  if (mode !== 'full' && mode !== 'config-only') {
    throw new Error(`非法还原模式: ${mode} (仅支持 'full' 或 'config-only')`);
  }

  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    const err = new Error('非法快照文件名');
    err.errorCode = 'SNAPSHOT_INVALID_NAME';
    throw err;
  }

  const loc = resolveSnapshotLocation(safeFilename);
  if (!loc) {
    const err = new Error('快照文件不存在: ' + safeFilename);
    err.errorCode = 'SNAPSHOT_NOT_FOUND';
    err.params = { file: safeFilename };
    throw err;
  }
  const snapshotPath = loc.filePath;
  const dshDir = paths.getDshDir();
  const dshPort = Number(process.env.DSH_PORT) || 3079;

  state.activeTask = {
    type: 'restore',
    label: `恢复快照(${mode === 'config-only' ? '仅配置' : '全量'})`,
    startedAt: Date.now()
  };
  console.log(`[backup-service] 开始安全还原快照: ${safeFilename} (模式: ${mode}, 目标: ${dshDir})...`);

  let rollbackRoot = null;
  let stagedItems = [];

  const isPreserved = (relPath) => {
    if (relPath === '.restore-staging' || relPath === '.restore-rollback') return true;
    if (mode === 'config-only') {
      const top = relPath.split(/[/\\]/)[0];
      if (DATA_ENTRIES.includes(top)) return true;
      const parts = relPath.split(/[/\\]/);
      if (parts.includes('node_modules')) return true;
    }
    return false;
  };

  const hasPreservedDescendant = (dir, currentRel, shouldSkip) => {
    try {
      const children = fs.readdirSync(dir);
      for (const child of children) {
        const childRel = currentRel ? path.join(currentRel, child) : child;
        if (shouldSkip(childRel)) return true;
        const childPath = path.join(dir, child);
        try {
          if (fs.lstatSync(childPath).isDirectory()) {
            if (hasPreservedDescendant(childPath, childRel, shouldSkip)) return true;
          }
        } catch {}
      }
    } catch {}
    return false;
  };

  const moveChildren = (from, to, shouldSkip = () => false, relBase = '') => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      const rel = relBase ? path.join(relBase, entry) : entry;
      if (shouldSkip(rel)) continue;

      const srcPath = path.join(from, entry);
      const dstPath = path.join(to, entry);
      let stat;
      try {
        stat = fs.lstatSync(srcPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (fs.existsSync(dstPath)) {
          moveChildren(srcPath, dstPath, shouldSkip, rel);
          try { fs.rmdirSync(srcPath); } catch {}
        } else if (hasPreservedDescendant(srcPath, rel, shouldSkip)) {
          fs.mkdirSync(dstPath, { recursive: true });
          moveChildren(srcPath, dstPath, shouldSkip, rel);
          try { fs.rmdirSync(srcPath); } catch {}
        } else {
          fs.renameSync(srcPath, dstPath);
        }
      } else {
        fs.renameSync(srcPath, dstPath);
      }
    }
  };

  function listAllRelPaths(dir, base = '') {
    let list = [];
    if (!fs.existsSync(dir)) return list;
    for (const f of fs.readdirSync(dir)) {
      const rel = base ? path.join(base, f) : f;
      const full = path.join(dir, f);
      try {
        const isDir = fs.lstatSync(full).isDirectory();
        list.push({ rel, isDir });
        if (isDir) {
          list = list.concat(listAllRelPaths(full, rel));
        }
      } catch {}
    }
    return list;
  }

  const rollback = () => {
    if (!rollbackRoot || !fs.existsSync(rollbackRoot)) return;
    console.warn('[backup-service] 正在精确逆向回滚到还原前的配置...');
    const sortedStaged = [...stagedItems].sort((a, b) => b.rel.length - a.rel.length);
    for (const item of sortedStaged) {
      if (isPreserved(item.rel)) continue;
      const targetPath = path.join(dshDir, item.rel);
      if (!fs.existsSync(targetPath)) continue;
      if (item.isDir) {
        try {
          if (fs.readdirSync(targetPath).length === 0) {
            fs.rmdirSync(targetPath);
          }
        } catch {}
      } else {
        try { fs.rmSync(targetPath, { force: true }); } catch {}
      }
    }
    moveChildren(rollbackRoot, dshDir, () => false);
    try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}
  };

  try {
    // 1. 预检归档完整性与成员白名单
    await validateArchiveMembers(snapshotPath);

    // 2. 优雅停止 DSH 并清理可能残留占用端口的孤儿进程
    if (dshManager && typeof dshManager.stop === 'function') {
      await dshManager.stop();
    }
    try { spawnSync('fuser', ['-k', '-9', `${dshPort}/tcp`], { stdio: 'ignore' }); } catch {}
    try {
      const psOut = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
      if (psOut.status === 0 && psOut.stdout) {
        for (const line of psOut.stdout.split('\n')) {
          if (/dsh\s+web|dsh-market-restart/i.test(line)) {
            const m = line.trim().match(/^(\d+)/);
            if (m && Number(m[1]) !== process.pid) {
              try { process.kill(Number(m[1]), 'SIGKILL'); } catch {}
            }
          }
        }
      }
    } catch {}

    // 3. 解压到同卷 staging 沙箱
    fs.mkdirSync(dshDir, { recursive: true });
    const stagingRoot = path.join(dshDir, '.restore-staging');
    rollbackRoot = path.join(dshDir, '.restore-rollback');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    const isMultiThread = hasPigz();
    const extractArgs = ['--warning=no-file-changed', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'];
    if (isMultiThread) extractArgs.push('-I', 'pigz');
    else extractArgs.push('-z');

    if (mode === 'config-only') {
      for (const entry of DATA_ENTRIES) {
        extractArgs.push(`--exclude=.dsh/${entry}`, `--exclude=./.dsh/${entry}`);
      }
      extractArgs.push('--exclude=.dsh/profiles/*/node_modules', '--exclude=./.dsh/profiles/*/node_modules', '--exclude=*/node_modules');
    }

    extractArgs.push('-xf', snapshotPath, '-C', stagingRoot);
    const extractRes = await runTarAsync(extractArgs, { timeoutMs: DEFAULT_SNAPSHOT_TIMEOUT_MS });
    if (extractRes.code !== 0) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('tar 解压到 staging 失败（现网未受影响）: ' + (extractRes.stderr || '未知错误'));
    }

    const stagedDsh = path.join(stagingRoot, '.dsh');
    if (!fs.existsSync(stagedDsh)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('快照内容异常：未找到 .dsh 目录，已中止（现网未受影响）');
    }

    // 3.0 config-only 二次清扫（兜底清除任何残留的数据目录与 node_modules）
    if (mode === 'config-only') {
      for (const entry of DATA_ENTRIES) {
        const p = path.join(stagedDsh, entry);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
      const profilesDir = path.join(stagedDsh, 'profiles');
      if (fs.existsSync(profilesDir)) {
        for (const child of fs.readdirSync(profilesDir)) {
          if (child === 'node_modules') {
            fs.rmSync(path.join(profilesDir, child), { recursive: true, force: true });
          } else {
            const subNm = path.join(profilesDir, child, 'node_modules');
            if (fs.existsSync(subNm)) {
              fs.rmSync(subNm, { recursive: true, force: true });
            }
          }
        }
      }
    }

    // 3.1 Keep-live：保留网关配置文件、会话密钥与内部接口令牌（修复还原后 /__internal 401）
    for (const keep of KEEP_LIVE_FILES) {
      const cur = path.join(dshDir, keep);
      if (fs.existsSync(cur)) {
        try {
          fs.copyFileSync(cur, path.join(stagedDsh, keep));
        } catch {}
      }
    }

    // 3.2 plugins-state.json 合并策略（修复还原后已卸载/停用插件复活）
    const liveStatePath = path.join(dshDir, 'plugins-state.json');
    const stagedStatePath = path.join(stagedDsh, 'plugins-state.json');
    const hasLiveState = fs.existsSync(liveStatePath);
    const hasStagedState = fs.existsSync(stagedStatePath);
    const unsupportedPlugins = (CAPABILITIES.browser && !CAPABILITIES.browser.pluginSupported)
      ? ['@dsh-custom/dsh-browser-desktop']
      : [];

    if (!hasStagedState) {
      if (hasLiveState) {
        try {
          fs.copyFileSync(liveStatePath, stagedStatePath);
        } catch {}
      }
    } else {
      const liveState = hasLiveState ? readPluginState(liveStatePath) : null;
      const snapState = readPluginState(stagedStatePath);
      const mergedState = mergePluginStates(liveState, snapState, { unsupportedPlugins });
      writePluginState(stagedStatePath, mergedState);
    }

    // 3.3 自动修复老快照逃出归档根的相对软链 + 重定位跨 DSH_HOME 的绝对软链
    const linkRepair = repairEscapingRelativeLinks(stagedDsh);
    if (linkRepair.repaired > 0) {
      console.log(`[backup-service] 已自动修复软链 ${linkRepair.repaired} 条（重定位 ${linkRepair.relocated} 条，保持原样 ${linkRepair.kept} 条）`);
      for (const s of linkRepair.samples) console.log(`[backup-service]   · ${s}`);
    }

    stagedItems = listAllRelPaths(stagedDsh);

    // 4. 原子切换（逐子项搬移，兼容卷挂载点）
    try {
      moveChildren(dshDir, rollbackRoot, isPreserved);
      moveChildren(stagedDsh, dshDir, () => false);
      console.log(`[backup-service] 配置已原子切换（旧配置备份于 ${rollbackRoot}）`);
    } catch (switchErr) {
      try {
        rollback();
      } catch (rb) {
        console.error('[backup-service] 切换失败后的即时回滚异常:', rb.message);
      }
      throw new Error('配置切换失败，已回滚到原配置: ' + switchErr.message);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }

    // 5. 若依赖缺失或 node_modules 为空，自动通过 pnpm 补全
    const webProfileDir = path.join(dshDir, 'profiles', 'web');
    const targetNodeModules = path.join(webProfileDir, 'node_modules');
    if (needsPnpmInstall(webProfileDir)) {
      console.log('[backup-service] 检测到快照依赖未完整落盘，正在通过 pnpm 自动补全...');
      const pnpmCode = await new Promise((resolve) => {
        const pnpmInstall = spawn('pnpm', ['install', '--no-frozen-lockfile'], {
          cwd: webProfileDir,
          stdio: 'ignore'
        });
        pnpmInstall.on('close', (code) => resolve(typeof code === 'number' ? code : -1));
        pnpmInstall.on('error', () => resolve(-1));
      });
      if (pnpmCode !== 0) {
        throw new Error('快照还原后补全依赖失败（pnpm install 退出码 ' + pnpmCode + '），已回滚到还原前状态');
      }
      let installedCount = 0;
      try { installedCount = fs.readdirSync(targetNodeModules).length; } catch {}
      if (installedCount === 0) {
        throw new Error('快照还原后 node_modules 仍为空（pnpm install 未产生有效产物）');
      }
    }

    // 6. 敏感文件权限自愈与插件/补丁同步
    try {
      if (fs.existsSync(dshDir)) fs.chmodSync(dshDir, 0o700);
      for (const secFile of SENSITIVE_MODE_600_FILES) {
        const p = path.join(dshDir, secFile);
        if (fs.existsSync(p)) {
          try { fs.chmodSync(p, 0o600); } catch {}
        }
      }
    } catch {}

    const installPluginScript = resolveScriptPath('install-plugin.mjs');
    if (installPluginScript) {
      await new Promise((r) => {
        const c = spawn(process.execPath, [installPluginScript], { stdio: 'ignore' });
        c.on('close', r);
        c.on('error', r);
      });
    }
    const patchScript = resolveScriptPath('patch-dsh-client.mjs');
    if (patchScript) {
      await new Promise((r) => {
        const c = spawn(process.execPath, [patchScript], { stdio: 'ignore' });
        c.on('close', r);
        c.on('error', r);
      });
    }

    // 7. 重新拉起 DSH 并验证就绪
    let dshReady = false;
    if (dshManager && typeof dshManager.boot === 'function') {
      const bootRes = await dshManager.boot();
      dshReady = bootRes && bootRes.ok === true;
      if (!dshReady) {
        throw new Error('快照解压完成，但 DSH 启动超时或未能成功就绪');
      }
    }

    try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}

    return {
      ok: true,
      filename: safeFilename,
      mode,
      dshReady,
      repairedLinks: linkRepair.repaired,
      relocatedLinks: linkRepair.relocated
    };
  } catch (err) {
    try {
      if (rollbackRoot && fs.existsSync(rollbackRoot)) {
        rollback();
        if (dshManager && typeof dshManager.boot === 'function') {
          await dshManager.boot().catch(() => {});
        }
        console.log('[backup-service] 已回滚到还原前的配置');
      }
    } catch (rbErr) {
      console.error('[backup-service] 回滚失败:', rbErr.message);
    }
    console.error('[backup-service] 快照还原异常:', err.message);
    throw err;
  } finally {
    state.activeTask = null;
  }
}

module.exports = {
  KEEP_LIVE_FILES,
  SENSITIVE_MODE_600_FILES,
  needsPnpmInstall,
  restoreBackup
};
