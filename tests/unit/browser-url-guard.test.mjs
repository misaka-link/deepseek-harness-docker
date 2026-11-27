#!/usr/bin/env node
/**
 * 回归测试：browser_open 的 URL 协议白名单。
 * 用法: node tests/unit/browser-url-guard.test.mjs
 */
import '../helpers/schemastery-stub.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-url-'));
const CFG = path.join(TMP, 'gateway.config.json');
fs.writeFileSync(CFG, JSON.stringify({ desktop: { enabled: true, width: 1280, height: 720 }, vncPath: '/vnc' }));
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.PROXY_PORT = '9';

const mod = await import(pathToFileURL(path.join(root, 'plugins/dsh-browser-desktop/index.js')).href);
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
    const msg = String((e && e.message) || e);
    ok(/仅支持 http\/https|不能为空|格式不合法|缺少主机名/.test(msg), `${label} → 拒绝`);
  }
}

try {
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
      ok(false, `${url} 竟然成功了`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      ok(!/仅支持 http\/https|格式不合法/.test(msg), `${url} 通过了协议校验`);
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
