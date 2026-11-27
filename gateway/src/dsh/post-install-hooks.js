'use strict';
/**
 * post-install-hooks.js — 核心切换/回滚/还原后的统一收尾钩子。
 *
 * 依次执行：
 *   1. install-plugin.mjs（插件依赖链接与 profile 同步）
 *   2. patch-dsh-client.mjs（客户端回环与服务端鉴权补丁）
 *   3. scripts/lib/needle-scan.mjs --json（验证无未修补 needle 残留）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CAPABILITIES = require('../core/capabilities');

function resolveScript(relPath) {
  const candidates = [
    path.join('/app/scripts', relPath),
    path.join(__dirname, '../../../scripts', relPath)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runPostInstallHooks({ log = () => {}, reason = 'switch' } = {}) {
  const result = {
    reason,
    pluginOk: true,
    patchOk: true,
    needleScan: null
  };

  const installPluginScript = resolveScript('install-plugin.mjs');
  if (installPluginScript) {
    const pluginDeps = CAPABILITIES.browser && CAPABILITIES.browser.pluginSupported
      ? '(schemastery & dsh-browser-desktop)'
      : '(schemastery)';
    log(`> 正在同步并链接插件依赖至核心 ${pluginDeps}...`);
    const res = spawnSync(process.execPath, [installPluginScript], { encoding: 'utf8' });
    if (res.stdout && res.stdout.trim()) log(res.stdout.trim());
    if (res.status !== 0) {
      result.pluginOk = false;
      if (res.stderr && res.stderr.trim()) log(`⚠️ install-plugin 告警: ${res.stderr.trim()}`);
    }
  }

  const patchScript = resolveScript('patch-dsh-client.mjs');
  if (patchScript) {
    log('> 正在应用客户端回环与鉴权补丁...');
    const res = spawnSync(process.execPath, [patchScript], { encoding: 'utf8' });
    if (res.stdout && res.stdout.trim()) log(res.stdout.trim());
    if (res.status !== 0) {
      result.patchOk = false;
      if (res.stderr && res.stderr.trim()) log(`⚠️ patch-dsh-client 告警: ${res.stderr.trim()}`);
    }
  }

  const needleScript = resolveScript('lib/needle-scan.mjs');
  if (needleScript) {
    const res = spawnSync(process.execPath, [needleScript, '--json'], { encoding: 'utf8' });
    try {
      if (res.stdout && res.stdout.trim()) {
        result.needleScan = JSON.parse(res.stdout);
        log(`✔ 客户端残留扫描完成: 扫描 ${result.needleScan.filesScanned} 个文件，残留 ${result.needleScan.needleResidue} 处`);
      }
    } catch {
      result.needleScan = { ok: res.status === 0, needleResidue: res.status === 0 ? 0 : -1 };
    }
  }

  return result;
}

module.exports = { runPostInstallHooks, resolveScript };
