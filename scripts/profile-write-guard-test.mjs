/**
 * P6 回归测试：控制台侧 profile 写入必须参与 DSH 写锁。
 *
 * 覆盖：
 *   A. 静态：网关与装配脚本都引入了锁/补丁模块，且关键写点带运行时护栏
 *   B. 静态：profile 的物理写点数量受控（每个都在锁内）
 *   C. 动态（关键）：模拟"DSH 先写入并持锁"的场景，运行真实 install-plugin.mjs，
 *      断言 DSH 的写入**没有被我们的装配流程覆盖**（这正是 P6 的丢更新）
 *
 * 用法: node scripts/profile-write-guard-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCK_MOD = path.join(here, 'profile-lock.cjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== A. 静态：模块引入与运行时护栏 ===');
const pmSrc = read('gateway/plugin-manager.js');
ok(/profile-lock\.cjs/.test(pmSrc), 'gateway/plugin-manager.js 引入 profile-lock.cjs');
ok(/patch-yaml\.cjs/.test(pmSrc), 'gateway/plugin-manager.js 引入 patch-yaml.cjs');
ok(/function writePackageJson[\s\S]{0,200}assertProfileLockHeld\(PROFILE_DIR\)/.test(pmSrc),
  'writePackageJson 带 assertProfileLockHeld 护栏');
ok(/function cleanPatchForPluginLocked[\s\S]{0,400}assertProfileLockHeld\(PROFILE_DIR\)/.test(pmSrc),
  'cleanPatchForPluginLocked 带 assertProfileLockHeld 护栏');
for (const fn of ['togglePlugin', 'uninstallPlugin', 'installPlugin']) {
  const re = new RegExp(`async function ${fn}\\([\\s\\S]*?withProfileLock\\(PROFILE_DIR`);
  ok(re.test(pmSrc), `${fn} 在 withProfileLock 内完成读-改-写`);
}
ok(/async function cleanPatchForPlugin\b[\s\S]{0,200}withProfileLock\(/.test(pmSrc),
  'cleanPatchForPlugin 对外入口自行取锁');
ok(/await pluginManager\.togglePlugin\(/.test(read('gateway/index.js')), 'index.js await togglePlugin');
ok(/await pluginManager\.uninstallPlugin\(/.test(read('gateway/index.js')), 'index.js await uninstallPlugin');
ok(/await pluginManager\.installPlugin\(/.test(read('gateway/index.js')), 'index.js await installPlugin');
ok(/await pm\.togglePlugin\(/.test(read('gateway/dsh-manager.js')), 'dsh-manager 自愈路径 await togglePlugin');

const ipSrc = read('scripts/install-plugin.mjs');
ok(/profile-lock\.cjs/.test(ipSrc), 'install-plugin.mjs 引入 profile-lock.cjs');
ok(/patch-yaml\.cjs/.test(ipSrc), 'install-plugin.mjs 引入 patch-yaml.cjs');
ok(/function writeProfile[\s\S]{0,300}withProfileLock\(profileDir/.test(ipSrc), 'install-plugin 的 writeProfile 在锁内');
ok(/assertPatchSafe\(/.test(ipSrc), 'install-plugin 的补丁清理带安全闸');
ok(/removePatchEntries\(/.test(ipSrc), 'install-plugin 使用外科手术式删除');

console.log('\n=== B. 静态：profile 物理写点受控 ===');
const pkgWrites = (ipSrc.match(/atomicWrite\(pkgPath/g) || []).length;
const patchWrites = (ipSrc.match(/atomicWrite\(patchPath/g) || []).length;
ok(pkgWrites === 2, `install-plugin 写 package.json 仅 2 处（实际 ${pkgWrites}: writeProfile / ensureProfilePackage）`);
ok(patchWrites === 1, `install-plugin 写 cordis.patch.yml 仅 1 处（实际 ${patchWrites}）`);
const gateCount = (ipSrc.match(/assertProfileLockHeld\(profileDir\)/g) || []).length;
ok(gateCount >= 3, `install-plugin 护栏出现 ${gateCount} 次（>=3）`);

console.log('\n=== C. 动态：DSH 并发写入不被我们的装配流程覆盖 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-guard-'));
const profileDir = path.join(tmp, '.dsh/profiles/web');
fs.mkdirSync(profileDir, { recursive: true });
const pkgPath = path.join(profileDir, 'package.json');
fs.writeFileSync(pkgPath, JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2) + '\n');

// 模拟 DSH：先取锁 → 写入自己的变更 → 持锁一段时间 → 释放
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
    await new Promise((r) => setTimeout(r, 2500)); // 模拟 DSH 的 pnpm 安装在锁内进行
  }, { label: 'competitor' });
})();
`);

const child = spawn(process.execPath, [competitor, profileDir], { stdio: ['ignore', 'pipe', 'inherit'] });
// 必须在 spawn 后立刻挂 exit 监听，避免子进程先退出导致 Promise 永不 settle
const childExited = new Promise((resolve) => child.on('exit', resolve));
let acquired = false;
child.stdout.on('data', (d) => { if (String(d).includes('ACQUIRED')) acquired = true; });
await Promise.race([(async () => { while (!acquired) await sleep(25); })(), sleep(5000)]);
ok(acquired, '竞争者已持有 profile 写锁并写入了自己的插件（dsh-side-plugin）');

// 在锁被占用期间运行真实的装配脚本
const installer = spawn(process.execPath, [path.join(ROOT, 'scripts/install-plugin.mjs')], {
  env: { ...process.env, DSH_HOME: tmp, DSH_PROFILE_DIR: profileDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
const installerExited = new Promise((resolve) => installer.on('exit', resolve));
let installerOut = '';
installer.stdout.on('data', (d) => { installerOut += String(d); });
installer.stderr.on('data', (d) => { installerOut += String(d); });

await installerExited;
await childExited;

const finalPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const bundles = finalPkg.dsh.profile.bundles;
ok(bundles.includes('dsh-side-plugin'), 'DSH 侧写入的 dsh-side-plugin 未被覆盖（无丢更新）');
ok(bundles.includes('@dsh-custom/dsh-browser-desktop'), '装配脚本自己的变更已生效');
ok(installerOut.includes('注册 bundle 依赖到 package.json 成功'), '装配脚本确实执行了写入路径');
ok(!fs.existsSync(path.join(profileDir, 'package.json.lock')), '结束后锁文件已释放（无残留）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
