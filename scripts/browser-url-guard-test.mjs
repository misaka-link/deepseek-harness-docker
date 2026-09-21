/**
 * P3 回归测试：browser_open 的 URL 协议白名单。
 * 用法: node scripts/browser-url-guard-test.mjs
 *
 * 校验发生在发起任何网络请求之前，因此无需网关/CDP 即可测试。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-url-'));
const CFG = path.join(TMP, 'gateway.config.json');
fs.writeFileSync(CFG, JSON.stringify({ desktop: { enabled: true, width: 1280, height: 720 }, vncPath: '/vnc' }));
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.PROXY_PORT = '9'; // 死端口：确保不会真的发出请求

const mod = await import(new URL('../plugins/dsh-browser-desktop/index.js', import.meta.url).href);
const tools = {};
mod.apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  systemPrompt: { section: () => () => {} },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
  on: () => {}
}, {});

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

async function expectReject(url, label) {
  try {
    await tools.browser_open.execute({ url }, { signal: null });
    ok(false, `${label}（本应被拒）`);
  } catch (e) {
    const msg = String(e && e.message || e);
    ok(/仅支持 http\/https|不能为空|格式不合法|缺少主机名/.test(msg), `${label} → 拒绝: ${msg.slice(0, 70)}`);
  }
}

console.log('\n=== A. 危险协议应被拒 ===');
await expectReject('file:///root/.dsh/gateway.config.json', 'file:// 读本地文件');
await expectReject('file:///etc/passwd', 'file:// 读系统文件');
await expectReject('javascript:alert(1)', 'javascript:');
await expectReject('data:text/html,<h1>x</h1>', 'data:');
await expectReject('chrome://settings', 'chrome://');
await expectReject('ftp://example.com/x', 'ftp://');
await expectReject('', '空 URL');
await expectReject('   ', '空白 URL');

console.log('\n=== B. 正常 http(s) 不应在协议校验处被拒 ===');
for (const url of ['http://127.0.0.1:9/login', 'https://example.com/a?b=1']) {
  try {
    await tools.browser_open.execute({ url }, { signal: null });
    ok(false, `${url} 竟然成功了（不应发生，死端口）`);
  } catch (e) {
    const msg = String(e && e.message || e);
    ok(!/仅支持 http\/https|格式不合法/.test(msg), `${url} 通过了协议校验（后续失败属预期: ${msg.slice(0, 40)}）`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
