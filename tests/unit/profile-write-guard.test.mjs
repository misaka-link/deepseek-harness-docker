#!/usr/bin/env node
/**
 * 控制台与装配脚本 profile 并发写保护回归测试。
 * 用法: node tests/unit/profile-write-guard.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const LOCK_MOD = path.join(ROOT, 'scripts/lib/profile-lock.cjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== A. 静态：模块引入与运行时护栏 ===');
const pmSrc = read('gateway/src/plugins/plugin-manager.js');
ok(/profile-lock\.cjs/.test(pmSrc), 'plugin-manager.js 引入 profile-lock.cjs');
ok(/patch-yaml\.cjs/.test(pmSrc), 'plugin-manager.js 引入 patch-yaml.cjs');
ok(/function writePackageJson[\s\S]{0,250}assertProfileLockHeld/.test(pmSrc), 'writePackageJson 带 assertProfileLockHeld 护栏');
ok(/function cleanPatchForPluginLocked[\s\S]{0,400}assertProfileLockHeld/.test(pmSrc), 'cleanPatchForPluginLocked 带 assertProfileLockHeld 护栏');
for (const fn of ['togglePlugin', 'uninstallPlugin', 'installPlugin']) {
  ok(new RegExp(`async function ${fn}\\([\\s\\S]*?withProfileLock\\(`).test(pmSrc), `${fn} 在 withProfileLock 内执行`);
}
const adminPluginsSrc = read('gateway/src/routes/admin/plugins.js');
ok(/await pluginManager\.togglePlugin\(/.test(adminPluginsSrc), 'routes/admin/plugins.js await togglePlugin');
ok(/await pluginManager\.uninstallPlugin\(/.test(adminPluginsSrc), 'routes/admin/plugins.js await uninstallPlugin');
ok(/await pluginManager\.installPlugin\(/.test(adminPluginsSrc), 'routes/admin/plugins.js await installPlugin');
ok(/await pm\.togglePlugin\(/.test(read('gateway/src/dsh/supervisor.js')), 'supervisor.js 自愈路径 await togglePlugin');

const ipSrc = read('scripts/install-plugin.mjs');
ok(/profile-lock\.cjs/.test(ipSrc) && /patch-yaml\.cjs/.test(ipSrc), 'install-plugin.mjs 引入锁与补丁库');
ok(/assertPatchSafe\(/.test(ipSrc) && /removePatchEntries\(/.test(ipSrc), 'install-plugin.mjs 使用安全闸与外科手术删除');
ok((ipSrc.match(/assertProfileLockHeld\(profileDir\)/g) || []).length >= 3, 'install-plugin.mjs 持锁护栏 >= 3 处');

console.log('\n=== B. 动态：DSH 并发写入不被装配脚本覆盖 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-guard-'));
try {
  const profileDir = path.join(tmp, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  const pkgPath = path.join(profileDir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
  }, null, 2) + '\n');

  const competitor = path.join(tmp, 'competitor.cjs');
  fs.writeFileSync(competitor, `
const { withProfileLock } = require(${JSON.stringify(LOCK_MOD)});
const fs = require('fs');
const path = require('path');
const profileDir = process.argv[2];
const pkgPath = path.join(profileDir, 'package.json');
(async () => {
  await withProfileLock(profileDir, async () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.dsh.profile.bundles.includes('dsh-side-plugin')) pkg.dsh.profile.bundles.push('dsh-side-plugin');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');
    process.stdout.write('ACQUIRED\\n');
    await new Promise((r) => setTimeout(r, 1500));
  }, { label: 'competitor' });
})();
`);

  const child = spawn(process.execPath, [competitor, profileDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const childExited = new Promise((resolve) => child.on('exit', resolve));
  let acquired = false;
  child.stdout.on('data', (d) => { if (String(d).includes('ACQUIRED')) acquired = true; });
  await Promise.race([(async () => { while (!acquired) await sleep(25); })(), sleep(5000)]);
  ok(acquired, '竞争者已持锁写入 dsh-side-plugin');

  const installer = spawn(process.execPath, [path.join(ROOT, 'scripts/install-plugin.mjs')], {
    env: { ...process.env, DSH_HOME: tmp, DSH_PROFILE_DIR: profileDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let installerOut = '';
  installer.stdout.on('data', (d) => { installerOut += String(d); });
  installer.stderr.on('data', (d) => { installerOut += String(d); });
  await new Promise((resolve) => installer.on('exit', resolve));
  await childExited;

  const finalPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bundles = finalPkg.dsh.profile.bundles;
  ok(bundles.includes('dsh-side-plugin'), 'DSH 侧写入未被覆盖');
  ok(bundles.includes('@dsh-custom/dsh-browser-desktop'), '装配脚本变更已生效');
  ok(!fs.existsSync(path.join(profileDir, 'package.json.lock')), '锁文件无残留');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
