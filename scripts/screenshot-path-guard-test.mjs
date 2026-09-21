/**
 * P1 回归：截图保存路径的工作区边界。
 * 用法: node scripts/screenshot-path-guard-test.mjs
 * 插件路径优先取当前仓库（便于本地验证未部署的改动），可用 DSH_PLUGIN_PATH 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = '/tmp/p1-workspace';
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_PLUGIN = path.resolve(HERE, '../plugins/dsh-browser-desktop/index.js');
const PLUGIN = process.env.DSH_PLUGIN_PATH
  || (fs.existsSync(REPO_PLUGIN) ? REPO_PLUGIN : '/app/plugins/dsh-browser-desktop/index.js');
console.log('插件: ' + PLUGIN);

const mod = await import(PLUGIN);
const tools = {};
mod.apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  systemPrompt: { section: () => () => {} },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
  on: () => {}
}, {});
const exec = { signal: null, agent: { session: { header: { cwd: WS } } } };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

console.log('\n=== A. 越界绝对路径应被拦回工作区 ===');
const esc1 = '/tmp/p1-escape-abs.png';
try { fs.unlinkSync(esc1); } catch {}
const r1 = await tools.browser_screenshot.execute({ savePath: esc1 }, exec);
ok(!fs.existsSync(esc1), '工作区外的绝对路径未被写入');
ok(String(r1.path).startsWith(WS), '返回路径落在工作区内: ' + r1.path);

console.log('\n=== B. ../ 越界应被拦回工作区 ===');
const esc2 = '/tmp/p1-escape-dotdot.png';
try { fs.unlinkSync(esc2); } catch {}
const r2 = await tools.browser_screenshot.execute({ savePath: '../../../tmp/p1-escape-dotdot.png' }, exec);
ok(!fs.existsSync(esc2), '../ 越界未被写入');
ok(String(r2.path).startsWith(WS), '返回路径落在工作区内: ' + r2.path);

console.log('\n=== C. 符号链接逃逸应被识破 ===');
const linkDir = WS + '/link-out';
try { fs.unlinkSync(linkDir); } catch {}
fs.symlinkSync('/tmp', linkDir);
const esc3 = '/tmp/p1-escape-symlink.png';
try { fs.unlinkSync(esc3); } catch {}
await tools.browser_screenshot.execute({ savePath: 'link-out/p1-escape-symlink.png' }, exec);
ok(!fs.existsSync(esc3), '经符号链接的越界写入被拦截');

console.log('\n=== D. 正常工作区路径应可用 ===');
const r4 = await tools.browser_screenshot.execute({ savePath: 'shot/ok.png' }, exec);
ok(fs.existsSync(r4.path) && String(r4.path).startsWith(WS), '工作区内相对路径可正常写入: ' + r4.path);

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
