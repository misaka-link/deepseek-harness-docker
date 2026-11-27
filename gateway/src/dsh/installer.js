'use strict';
/**
 * installer.js — DSH 核心版本切换安装与回滚点就地还原引擎。
 *
 * v1.0.0 核心强化：
 *   1) installVersion 与 restoreRollbackPoint 内部强制执行 ENGINE_FLOOR (>= 0.2.3-alpha.2) 与
 *      danger 级版本阻断，防止通过任意入口切换到不兼容旧引擎或破坏性大版本；
 *   2) 统一通过 post-install-hooks.js 执行插件装配、客户端补丁与 needle 扫描；
 *   3) 进度回调同时发出结构化 labelKey / params 与中文 label，兼容多语言与既有前端。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const paths = require('../core/paths');
const { isValidVersion, resolveWithinDir } = require('./dsh-version');
const versionService = require('./version-service');
const {
  FALLBACK_DSH_VERSION,
  GC_KEEP_DEFAULT,
  MIN_FREE_BYTES,
  getLiveCoreParent,
  getLiveCoreDir,
  getDshBinLink,
  getRollbackPreservedDir,
  getStoreStagingDir,
  runSyncSafe,
  isReadyVersionDir,
  writeReadyMarker,
  dirSizeBytes,
  formatBytes,
  isMountedPath,
  touchVersionUsage,
  atomicSwapCore,
  assertDiskSpace
} = require('./version-store');
const {
  promoteToPreservedRollback,
  disposeRollbackDir,
  restoreFromRollbackDir,
  getRollbackPoint
} = require('./rollback-slot');
const { runPostInstallHooks } = require('./post-install-hooks');
const { getDshPort } = require('./supervisor');

async function installVersion(manager, version, onProgress, onLog, options = {}) {
  const normalizedVersion = typeof version === 'string' ? version.trim() : '';
  if (!isValidVersion(normalizedVersion)) {
    return {
      ok: false,
      errorCode: 'DSH_VERSION_INVALID',
      params: { version: String(version || '').slice(0, 64) },
      error: `版本号格式不合法: ${String(version).slice(0, 64)}`
    };
  }
  version = normalizedVersion;

  // 硬闸门：在安装/归档切换前强制执行 v1 兼容策略（< 0.2.3-alpha.2 与 >= 0.3.0 硬阻断）
  const compatEval = versionService.evaluateTargetVersion(version);
  if (compatEval.level === 'danger') {
    const errorCode = compatEval.kind === 'engine-unsupported'
      ? 'DSH_ENGINE_UNSUPPORTED'
      : 'DSH_VERSION_BREAKING';
    return {
      ok: false,
      errorCode,
      params: compatEval.params || { version },
      error: compatEval.message || `目标版本 v${version} 不受支持，已禁止切换`
    };
  }

  if (manager.installing) {
    return { ok: false, errorCode: 'DSH_BUSY_INSTALLING', error: '已有安装任务正在进行中' };
  }
  manager.installing = true;
  manager.installLog = [];

  if (typeof onProgress === 'function' && typeof onLog !== 'function') {
    onLog = onProgress;
    onProgress = null;
  }

  const log = (msg) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    manager.installLog.push(line);
    if (typeof onLog === 'function') onLog(line);
    console.log(`[dsh-installer] ${msg}`);
  };

  const emitProgress = (data) => {
    if (typeof onProgress === 'function') {
      try { onProgress(data); } catch {}
    }
  };

  const versionsDir = paths.getVersionsDir();
  const storeStagingDir = getStoreStagingDir();
  const liveCoreParent = getLiveCoreParent();
  const liveCoreDir = getLiveCoreDir();
  const binLink = getDshBinLink();
  const dshPort = getDshPort();

  try { fs.mkdirSync(storeStagingDir, { recursive: true }); } catch {}

  const previousVersion = manager.getCurrentVersion() || FALLBACK_DSH_VERSION;
  const archiveCurrent = options && options.archiveCurrent === true;
  let stagingDir = null;
  let tmpPrefix = null;
  let rollbackDir = null;
  let coreMutated = false;

  try {
    // === 阶段 1/5: 切换预检 ===
    emitProgress({
      step: 1, total: 5, percent: 10,
      labelKey: 'dsh.install.step.preflight',
      params: { version, previousVersion },
      label: '环境预检与版本兼容性评估',
      mode: 'install'
    });
    log('======================================================================');
    log(`=== [阶段 1/5] 切换预检: 当前运行版本 ${previousVersion} -> 目标版本 ${version} ===`);
    if (version === previousVersion) {
      log(`ℹ️ 目标版本与当前运行版本一致 (${version})，将执行环境重新装配与就绪校验。`);
    }

    if (!compatEval.isAdapted) {
      log('⚠️ [适配性提醒] 目标版本尚未收录在官方深度适配清单中，请留意上游变更。');
    } else {
      log(`✔ 目标版本 ${version} 属于官方深度适配版本。`);
    }
    log(`✔ 预检通过：环境就绪，软件源: ${manager.registry}`);

    assertDiskSpace([versionsDir, liveCoreParent], MIN_FREE_BYTES, log, () => getRollbackPoint(true));

    // === 阶段 2/5: （可选）归档当前引擎 ===
    emitProgress({
      step: 2, total: 5, percent: 25,
      labelKey: archiveCurrent ? 'dsh.install.step.archive' : 'dsh.install.step.skipArchive',
      params: { version: previousVersion },
      label: archiveCurrent ? '备份当前引擎版本' : '跳过引擎备份',
      mode: 'install'
    });
    log(`=== [阶段 2/5] 当前引擎版本归档（${archiveCurrent ? '用户已勾选' : '未勾选 → 跳过'}） ===`);
    log(`📦 版本库: ${versionsDir}${isMountedPath(versionsDir) ? ' (持久化卷 ✔)' : ' (⚠️ 非挂载点)'}`);

    if (!archiveCurrent) {
      log('ℹ️ 未勾选「归档当前引擎」，跳过归档（失败仍会自动本地回滚）。');
    } else if (!isValidVersion(previousVersion)) {
      log(`⚠️ 跳过归档：当前版本号不合法 (${previousVersion})`);
    } else {
      const prevArchive = resolveWithinDir(versionsDir, previousVersion);
      if (isReadyVersionDir(prevArchive)) {
        touchVersionUsage(versionsDir, previousVersion);
        log(`✔ 版本库中已存在完整归档 ${previousVersion}，无需重复归档`);
      } else {
        if (fs.existsSync(prevArchive)) {
          log(`⚠️ 检测到不完整的旧归档 ${previousVersion}，删除重建`);
          fs.rmSync(prevArchive, { recursive: true, force: true });
        }
        if (fs.existsSync(path.join(liveCoreDir, 'package.json'))) {
          log(`正在归档当前引擎 ${previousVersion} 至持久化版本库...`);
          const archTmp = path.join(storeStagingDir, `archive-${process.pid}-${Date.now()}`);
          try {
            fs.mkdirSync(archTmp, { recursive: true });
            runSyncSafe('cp', ['-a', liveCoreDir + '/.', archTmp + '/']);
            writeReadyMarker(archTmp, previousVersion);
            fs.renameSync(archTmp, prevArchive);
            log(`✔ 已归档 ${previousVersion} (${formatBytes(dirSizeBytes(prevArchive))})`);
          } catch (e) {
            try { fs.rmSync(archTmp, { recursive: true, force: true }); } catch {}
            log(`⚠️ 归档失败（不影响本次切换）: ${e.message}`);
          }
        }
      }
    }

    // === 阶段 3/5: 部署目标核心版本 ===
    emitProgress({
      step: 3, total: 5, percent: 40,
      labelKey: 'dsh.install.step.deploy',
      params: { version },
      label: '获取目标版本核心包',
      mode: 'install'
    });
    log(`=== [阶段 3/5] 部署目标核心版本 @deepseek-ai/dsh@${version} ===`);
    const targetArchive = resolveWithinDir(versionsDir, version);
    let sourceDir = null;

    if (isReadyVersionDir(targetArchive)) {
      sourceDir = targetArchive;
      touchVersionUsage(versionsDir, version);
      log(`⚡ [免下载] 命中持久化版本库 ${version}，直接从本地归档部署`);
    } else {
      if (fs.existsSync(targetArchive)) {
        log(`⚠️ 版本库中的 ${version} 归档不完整，重新下载`);
        fs.rmSync(targetArchive, { recursive: true, force: true });
      }
      log(`正在从 npm 镜像源下载并安装 @deepseek-ai/dsh@${version} (源: ${manager.registry})...`);
      const tmpPrefixPath = path.join(storeStagingDir, `npm-${process.pid}-${Date.now()}`);
      tmpPrefix = tmpPrefixPath;
      fs.mkdirSync(tmpPrefixPath, { recursive: true });
      const installArgs = [
        'install', '-g', '--prefix', tmpPrefixPath, '--omit=dev', '--no-audit', '--no-fund',
        `--registry=${manager.registry}`,
        `@deepseek-ai/dsh@${version}`
      ];
      log(`> npm ${installArgs.join(' ')}`);

      const startTime = Date.now();
      const child = spawn('npm', installArgs, { env: process.env });

      const heartbeat = setInterval(() => {
        const sec = Math.floor((Date.now() - startTime) / 1000);
        const dynamicPercent = Math.min(59, 40 + Math.floor(sec * 1.2));
        log(`⏳ [npm 依赖拉取中] 已耗时 ${sec}s...`);
        emitProgress({
          step: 3, total: 5, percent: dynamicPercent,
          labelKey: 'dsh.install.step.downloading',
          params: { seconds: sec },
          label: `下载核心依赖包 (已耗时 ${sec}s)...`,
          mode: 'install'
        });
      }, 2000);

      child.stdout.on('data', (d) => d.toString().split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => log(l)));
      child.stderr.on('data', (d) => d.toString().split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => log(l)));

      const exitCode = await new Promise((r) => child.on('close', r));
      clearInterval(heartbeat);

      if (exitCode !== 0) {
        try { fs.rmSync(tmpPrefix, { recursive: true, force: true }); } catch {}
        throw new Error(`npm install 安装异常，退出码: ${exitCode}`);
      }
      log(`✔ npm 下载并解压完成，总耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

      try {
        const rb = spawnSync('npm', ['rebuild', 'node-pty', '--foreground-scripts', '--prefix', tmpPrefixPath], { encoding: 'utf8', timeout: 180000 });
        if (rb.status !== 0) log(`⚠️ node-pty 原生重建未成功（不阻断）: ${String(rb.stderr || '').trim().slice(0, 200)}`);
        else log('✔ node-pty 原生模块已就绪');
      } catch (e) {
        log(`⚠️ node-pty 原生重建异常（不阻断）: ${e.message}`);
      }

      sourceDir = path.join(tmpPrefixPath, 'lib/node_modules/@deepseek-ai/dsh');
      if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        throw new Error('npm 安装完成但未找到 @deepseek-ai/dsh 产物');
      }
      emitProgress({
        step: 3, total: 5, percent: 60,
        labelKey: 'dsh.install.step.downloaded',
        params: { version },
        label: '目标版本下载安装完成',
        mode: 'install'
      });
    }

    assertDiskSpace([versionsDir, liveCoreParent], MIN_FREE_BYTES, log, () => getRollbackPoint(true));

    const stagingPath = path.join(liveCoreParent, `.dsh-staging-${process.pid}-${Date.now()}`);
    stagingDir = stagingPath;
    fs.mkdirSync(stagingPath, { recursive: true });
    runSyncSafe('cp', ['-a', sourceDir + '/.', stagingPath + '/']);
    const stagedPkg = JSON.parse(fs.readFileSync(path.join(stagingPath, 'package.json'), 'utf8'));
    if (stagedPkg.version !== version) {
      throw new Error(`staging 版本校验失败：期望 ${version}，实际 ${stagedPkg.version}`);
    }
    log(`✔ 目标版本 ${version} 已在隔离 staging 目录就绪`);
    if (tmpPrefix) { try { fs.rmSync(tmpPrefix, { recursive: true, force: true }); } catch {} tmpPrefix = null; }

    log('正在停止 DSH 进程以执行核心目录原子置换...');
    coreMutated = true;
    await manager.stop();
    rollbackDir = atomicSwapCore(stagingPath);
    stagingDir = null;
    log('✔ 核心目录已完成原子置换');

    // === 阶段 4/5: 插件装配、客户端补丁与残留扫描 ===
    emitProgress({
      step: 4, total: 5, percent: 70,
      labelKey: 'dsh.install.step.hooks',
      params: { version },
      label: '插件装配与补丁自愈',
      mode: 'install'
    });
    log('=== [阶段 4/5] 插件环境装配、补丁注入与残留扫描 ===');
    const hookRes = runPostInstallHooks({ log, reason: `install:${version}` });
    if (hookRes.needleScan) manager.lastNeedleScan = hookRes.needleScan;
    log('✔ 插件与宿主补丁适配完成');
    emitProgress({
      step: 4, total: 5, percent: 80,
      labelKey: 'dsh.install.step.hooksDone',
      params: { version },
      label: '插件与补丁适配就绪',
      mode: 'install'
    });

    // === 阶段 5/5: 拉起新服务并健康探活 ===
    emitProgress({
      step: 5, total: 5, percent: 85,
      labelKey: 'dsh.install.step.probe',
      params: { version },
      label: '拉起新服务并健康探活',
      mode: 'install'
    });
    log(`=== [阶段 5/5] 拉起新版本 DSH (${version}) 并执行健康就绪探活 ===`);
    manager.lastExitInfo = null;
    manager.recentLogs = [];

    const bootRes = await manager.restart((probe) => {
      const dynamicPercent = Math.min(97, 85 + Math.floor(probe.attempts * 0.8));
      log(`🔍 [健康探活] 探测端口 ${dshPort} (第 ${probe.attempts} 次, 已等待 ${probe.elapsedSec}s)...`);
      emitProgress({
        step: 5, total: 5, percent: dynamicPercent,
        labelKey: 'dsh.install.step.probing',
        params: { attempts: probe.attempts, elapsedSec: probe.elapsedSec },
        label: `端口健康就绪探活中 (${probe.attempts}/30)...`,
        mode: 'install'
      });
    });

    if (!bootRes.ok) {
      let failDetail = `新版本 ${version} 启动后未能通过端口健康就绪探测`;
      if (manager.lastExitInfo) {
        failDetail = `新版本进程启动异常退出 (Exit Code: ${manager.lastExitInfo.code}, Signal: ${manager.lastExitInfo.sig || 'none'})`;
      }
      throw new Error(failDetail);
    }

    manager.lastKnownVersion = '';
    const currentVer = manager.getCurrentVersion();
    if (rollbackDir && fs.existsSync(rollbackDir)) {
      try {
        promoteToPreservedRollback(rollbackDir, previousVersion);
        log('✔ 前序核心已转为就地回滚点保留');
      } catch (promoteErr) {
        log(`⚠️ 回滚点提升保留跳过: ${promoteErr.message}`);
      }
      rollbackDir = null;
    }

    manager.installing = false;
    manager.lastKnownVersion = '';

    try {
      const gc = manager.gcVersions({ keepN: GC_KEEP_DEFAULT, activeVersion: currentVer });
      if (gc && gc.ok && Array.isArray(gc.removed) && gc.removed.length) {
        log(`🧹 版本库 GC：已清理 ${gc.removed.length} 个旧版本，释放 ${formatBytes(gc.freedBytes)}`);
      }
    } catch (e) {
      log(`⚠️ 版本库 GC 跳过: ${e.message}`);
    }

    emitProgress({
      step: 5, total: 5, percent: 100,
      labelKey: 'dsh.install.step.done',
      params: { version: currentVer },
      label: `切换完成！核心已成功升级至 v${currentVer}`,
      mode: 'install'
    });
    log(`🎉 [SUCCESS] DSH 核心版本切换成功！当前运行版本: v${currentVer}`);
    return { ok: true, version: currentVer };

  } catch (err) {
    if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {} stagingDir = null; }
    if (tmpPrefix) { try { fs.rmSync(tmpPrefix, { recursive: true, force: true }); } catch {} tmpPrefix = null; }
    log(`❌ 新版本安装或启动失败: ${err.message}`);

    if (!coreMutated) {
      log(`ℹ️ 现网核心未做任何改动，服务继续运行在 v${previousVersion}`);
      manager.installing = false;
      manager.lastKnownVersion = '';
      return {
        ok: false,
        errorCode: err.errorCode || 'DSH_INSTALL_FAILED',
        params: err.params || { step: 'preflight', version },
        error: `切换已中止（现网未受影响）: ${err.message}`,
        untouched: true,
        version: previousVersion
      };
    }

    if (!rollbackDir && err && err.rollbackDir && fs.existsSync(err.rollbackDir)) {
      rollbackDir = err.rollbackDir;
    }

    log(`⚠️ 触发安全熔断保护：正在回滚至稳定版本 v${previousVersion}...`);
    emitProgress({
      step: 1, total: 3, percent: 30,
      labelKey: 'dsh.rollback.step.restore',
      params: { version: previousVersion },
      label: `🛡️ 触发安全熔断：正在还原稳定版本 v${previousVersion}...`,
      mode: 'rollback'
    });

    try {
      if (rollbackDir && fs.existsSync(rollbackDir)) {
        await manager.stop();
        restoreFromRollbackDir(rollbackDir);
        rollbackDir = null;
      } else {
        const prevCached = resolveWithinDir(versionsDir, previousVersion);
        if (isReadyVersionDir(prevCached)) {
          await manager.stop();
          const rbStaging = path.join(liveCoreParent, `.dsh-staging-rb-${process.pid}-${Date.now()}`);
          fs.mkdirSync(rbStaging, { recursive: true });
          try {
            runSyncSafe('cp', ['-a', prevCached + '/.', rbStaging + '/']);
            disposeRollbackDir(atomicSwapCore(rbStaging));
          } catch (rbSwapErr) {
            try { fs.rmSync(rbStaging, { recursive: true, force: true }); } catch {}
            throw rbSwapErr;
          }
        } else {
          const rbArgs = [
            'install', '-g', '--omit=dev', '--no-audit', '--no-fund',
            `--registry=${manager.registry}`,
            `@deepseek-ai/dsh@${previousVersion}`
          ];
          const rbChild = spawn('npm', rbArgs, { env: process.env });
          rbChild.stdout.on('data', (d) => d.toString().split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => log(`[回滚] ${l}`)));
          rbChild.stderr.on('data', (d) => d.toString().split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => log(`[回滚] ${l}`)));
          const rbExit = await new Promise((r) => rbChild.on('close', r));
          if (rbExit !== 0) throw new Error(`npm 回滚安装异常，退出码: ${rbExit}`);
          try { runSyncSafe('ln', ['-sfn', path.join(liveCoreDir, 'lib/bin.js'), binLink]); } catch {}
        }
      }

      emitProgress({
        step: 2, total: 3, percent: 65,
        labelKey: 'dsh.rollback.step.hooks',
        params: { version: previousVersion },
        label: '🛡️ 熔断回滚 [2/3]: 恢复稳定版本插件配置与补丁',
        mode: 'rollback'
      });
      const rbHooks = runPostInstallHooks({ log, reason: `rollback:${previousVersion}` });
      if (rbHooks.needleScan) manager.lastNeedleScan = rbHooks.needleScan;

      emitProgress({
        step: 3, total: 3, percent: 85,
        labelKey: 'dsh.rollback.step.probe',
        params: { version: previousVersion },
        label: '🛡️ 熔断回滚 [3/3]: 正在重新拉起稳定核心并探活...',
        mode: 'rollback'
      });
      const rbBoot = await manager.restart((probe) => {
        emitProgress({
          step: 3, total: 3, percent: Math.min(98, 85 + probe.attempts * 2),
          labelKey: 'dsh.rollback.step.probing',
          params: { attempts: probe.attempts, elapsedSec: probe.elapsedSec },
          label: `🛡️ 熔断回滚 [3/3]: 稳定版本就绪探活中 (${probe.attempts}/30)...`,
          mode: 'rollback'
        });
      });
      if (!rbBoot.ok) throw new Error('稳定版本重启失败，无法进入正常就绪状态');

      emitProgress({
        step: 3, total: 3, percent: 100,
        labelKey: 'dsh.rollback.step.done',
        params: { version: previousVersion },
        label: `🛡️ 自动回滚完成！系统已恢复至稳定版本 v${previousVersion}`,
        mode: 'rollback'
      });

      manager.installing = false;
      manager.lastKnownVersion = '';
      return {
        ok: false,
        errorCode: 'DSH_ROLLED_BACK',
        params: { version: previousVersion, targetVersion: version },
        error: `目标版本 ${version} 启动失败: ${err.message}，系统已自动安全回滚至稳定版本 ${previousVersion}`,
        rolledBack: true,
        version: previousVersion
      };
    } catch (rbErr) {
      log(`💥 自动回滚遇到异常: ${rbErr.message}`);
      if (rollbackDir && fs.existsSync(rollbackDir) && !fs.existsSync(path.join(liveCoreDir, 'package.json'))) {
        try {
          restoreFromRollbackDir(rollbackDir);
          rollbackDir = null;
        } catch {}
      }
      let booted = false;
      if (fs.existsSync(path.join(liveCoreDir, 'package.json'))) {
        try {
          const b = await manager.boot();
          booted = !!(b && b.ok);
        } catch {}
      }
      manager.installing = false;
      manager.lastKnownVersion = '';
      return {
        ok: false,
        errorCode: 'DSH_INSTALL_FAILED',
        params: { step: 'rollback', version: previousVersion },
        error: `切换失败且回滚异常: ${rbErr.message}`,
        rolledBack: booted,
        version: previousVersion
      };
    }
  }
}

async function restoreRollbackPoint(manager, onProgress = () => {}, onLog = () => {}) {
  manager.installLog = [];
  if (typeof onProgress === 'function' && typeof onLog !== 'function') {
    onLog = onProgress;
    onProgress = null;
  }

  const log = (msg) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    manager.installLog.push(line);
    if (typeof onLog === 'function') onLog(line);
    console.log(`[dsh-restore] ${msg}`);
  };
  const emitProgress = (data) => {
    if (typeof onProgress === 'function') {
      try { onProgress(data); } catch {}
    }
  };

  if (manager.installing) {
    return { ok: false, errorCode: 'ROLLBACK_BUSY', error: '已有任务正在进行中，请稍候' };
  }

  // 前置校验回滚点版本下限（绝不还原 < 0.2.3-alpha.2 或 >= 0.3.0 的回滚点）
  const preCheck = getRollbackPoint(false);
  if (!preCheck.exists) {
    return { ok: false, errorCode: 'ROLLBACK_NOT_FOUND', error: '回滚点备件不存在，无法就地还原' };
  }
  if (preCheck.version) {
    const evalRes = versionService.evaluateTargetVersion(preCheck.version);
    if (evalRes.level === 'danger') {
      const errorCode = evalRes.kind === 'engine-unsupported'
        ? 'DSH_ENGINE_UNSUPPORTED'
        : 'DSH_VERSION_BREAKING';
      return {
        ok: false,
        errorCode,
        params: evalRes.params || { version: preCheck.version },
        error: evalRes.message || `回滚点版本 v${preCheck.version} 低于最低支持要求，已拒绝还原`
      };
    }
  }

  manager.installing = true;
  let staging = null;
  let newRb = null;
  const previousVersion = manager.getCurrentVersion();
  const preservedDir = getRollbackPreservedDir();
  const liveCoreParent = getLiveCoreParent();
  const dshPort = getDshPort();

  try {
    emitProgress({
      step: 1, total: 5, percent: 10,
      labelKey: 'dsh.restore.step.preflight',
      params: { version: preCheck.version },
      label: '环境检查与回滚点备件校验',
      mode: 'install'
    });
    log('=== [阶段 1/5] 回滚点备件完整性与 ABI 预检 ===');

    if (!preCheck.abiMatches) {
      const err = new Error(`回滚点 Node ABI (${preCheck.nodeAbi}) 与当前运行环境 (${process.versions.modules}) 不匹配`);
      err.errorCode = 'ROLLBACK_ABI_MISMATCH';
      err.params = { expected: String(process.versions.modules), actual: String(preCheck.nodeAbi) };
      throw err;
    }
    if (!fs.existsSync(path.join(preservedDir, 'package.json'))) {
      throw new Error('回滚点目录缺失 package.json，已被损坏');
    }

    const targetVersion = preCheck.version || 'unknown';
    log(`✔ 回滚点校验通过: 目标版本 v${targetVersion}，体积 ${preCheck.sizeFormatted}`);
    assertDiskSpace([liveCoreParent], MIN_FREE_BYTES, log, () => preCheck);

    emitProgress({
      step: 2, total: 5, percent: 25,
      labelKey: 'dsh.restore.step.stage',
      params: { version: targetVersion },
      label: '停止服务并复制备件至 staging',
      mode: 'install'
    });
    await manager.stop();

    staging = path.join(liveCoreParent, `.dsh-staging-restore-${process.pid}-${Date.now()}`);
    fs.mkdirSync(staging, { recursive: true });
    runSyncSafe('cp', ['-a', preservedDir + '/.', staging + '/']);

    emitProgress({
      step: 3, total: 5, percent: 50,
      labelKey: 'dsh.restore.step.swap',
      params: { version: targetVersion },
      label: '原子置换核心目录',
      mode: 'install'
    });
    newRb = atomicSwapCore(staging);
    staging = null;

    emitProgress({
      step: 4, total: 5, percent: 75,
      labelKey: 'dsh.restore.step.hooks',
      params: { version: targetVersion },
      label: '插件装配与补丁自愈',
      mode: 'install'
    });
    const hookRes = runPostInstallHooks({ log, reason: `restore-rollback:${targetVersion}` });
    if (hookRes.needleScan) manager.lastNeedleScan = hookRes.needleScan;

    emitProgress({
      step: 5, total: 5, percent: 85,
      labelKey: 'dsh.restore.step.probe',
      params: { version: targetVersion },
      label: '拉起服务并健康探活',
      mode: 'install'
    });
    manager.lastExitInfo = null;
    manager.recentLogs = [];

    const bootRes = await manager.restart((probe) => {
      const dynamicPercent = Math.min(97, 85 + Math.floor(probe.attempts * 0.8));
      log(`🔍 [健康探活] 探测端口 ${dshPort} (第 ${probe.attempts} 次, 已等待 ${probe.elapsedSec}s)...`);
      emitProgress({
        step: 5, total: 5, percent: dynamicPercent,
        labelKey: 'dsh.restore.step.probing',
        params: { attempts: probe.attempts, elapsedSec: probe.elapsedSec },
        label: `端口健康就绪探活中 (${probe.attempts}/30)...`,
        mode: 'install'
      });
    });

    if (!bootRes.ok) {
      let failDetail = `还原版本 ${targetVersion} 启动后未能通过端口健康就绪探测`;
      if (manager.lastExitInfo) {
        failDetail = `还原版本进程启动异常退出 (Exit Code: ${manager.lastExitInfo.code}, Signal: ${manager.lastExitInfo.sig || 'none'})`;
      }
      throw new Error(failDetail);
    }

    if (newRb && fs.existsSync(newRb)) {
      try {
        promoteToPreservedRollback(newRb, previousVersion);
        newRb = null;
        log(`✔ 原活动版本 (v${previousVersion}) 已轮替存入就地回滚点`);
      } catch (promoteErr) {
        log(`⚠️ 回滚点轮替提升警告: ${promoteErr.message}`);
      }
    }

    manager.lastKnownVersion = '';
    const currentVer = manager.getCurrentVersion();
    emitProgress({
      step: 5, total: 5, percent: 100,
      labelKey: 'dsh.restore.step.done',
      params: { version: currentVer },
      label: `还原完成！当前核心已恢复至 v${currentVer}`,
      mode: 'install'
    });
    log(`🎉 [SUCCESS] DSH 核心就地还原成功！当前版本: v${currentVer}`);
    return { ok: true, version: currentVer };

  } catch (err) {
    log(`❌ 还原失败: ${err.message}`);
    if (newRb && fs.existsSync(newRb)) {
      emitProgress({
        step: 1, total: 3, percent: 40,
        labelKey: 'dsh.rollback.step.restore',
        params: { version: previousVersion },
        label: `🛡️ 正在撤销置换并恢复原活动核心 v${previousVersion}...`,
        mode: 'rollback'
      });
      try {
        await manager.stop();
        restoreFromRollbackDir(newRb);
        newRb = null;
        const revHooks = runPostInstallHooks({ log, reason: `revert-rollback:${previousVersion}` });
        if (revHooks.needleScan) manager.lastNeedleScan = revHooks.needleScan;

        emitProgress({
          step: 2, total: 3, percent: 75,
          labelKey: 'dsh.rollback.step.probe',
          params: { version: previousVersion },
          label: '🛡️ 重新拉起原核心并健康探活...',
          mode: 'rollback'
        });
        await manager.restart();
        emitProgress({
          step: 3, total: 3, percent: 100,
          labelKey: 'dsh.rollback.step.done',
          params: { version: previousVersion },
          label: `🛡️ 已安全回退至原活动版本 v${previousVersion}`,
          mode: 'rollback'
        });
        return {
          ok: false,
          rolledBack: true,
          errorCode: err.errorCode || 'DSH_ROLLED_BACK',
          params: err.params || { version: previousVersion },
          error: err.message,
          version: previousVersion
        };
      } catch (revErr) {
        return {
          ok: false,
          rolledBack: false,
          errorCode: 'DSH_INSTALL_FAILED',
          error: `还原失败且撤销异常: ${revErr.message}`,
          version: previousVersion
        };
      }
    }

    return {
      ok: false,
      rolledBack: false,
      errorCode: err.errorCode || 'DSH_INSTALL_FAILED',
      params: err.params || {},
      error: err.message,
      version: previousVersion
    };
  } finally {
    if (staging && fs.existsSync(staging)) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
    if (newRb && fs.existsSync(newRb)) {
      try { fs.rmSync(newRb, { recursive: true, force: true }); } catch {}
    }
    manager.installing = false;
    manager.lastKnownVersion = '';
  }
}

module.exports = { installVersion, restoreRollbackPoint };
