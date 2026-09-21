/**
 * S3 回归测试：空口令 → 初始化向导状态机 + 口令强度校验（纯函数层）。
 * 用法: node scripts/setup-gate-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 关键：必须在 require 之前清空 AUTH_TOKEN，模拟"未设置口令"的首次启动
process.env.AUTH_TOKEN = '';
process.env.ACCESS_CODE = '';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const auth = require(path.join(here, '../gateway/auth.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

console.log('\n=== A. 空口令 ⇒ 需要初始化 ===');
ok(auth.isAuthEnabled() === false, '空口令时 auth 未启用');
ok(auth.isSetupRequired() === true, '空口令时必须走初始化向导');

console.log('\n=== B. 设置口令后 ⇒ 不再需要初始化 ===');
auth.updateAuthToken('Str0ng-Pass!');
ok(auth.isAuthEnabled() === true, '设置后 auth 已启用');
ok(auth.isSetupRequired() === false, '设置后不再需要初始化');
ok(auth.verifyToken('Str0ng-Pass!') === true, '新口令校验通过');
ok(auth.verifyToken('wrong') === false, '错误口令被拒');

console.log('\n=== C. 清除口令 ⇒ 回到初始化 ===');
auth.updateAuthToken('');
ok(auth.isSetupRequired() === true, '清除后重新需要初始化');

console.log('\n=== D. 口令强度校验 ===');
for (const p of ['admin', 'Admin', 'password', '12345678', 'qwertyuiop', 'short', '', '   ', 'deepseek', 'letmein']) {
  ok(auth.isWeakPassword(p) === true, `弱口令被拒: ${JSON.stringify(p)}`);
}
for (const p of ['Str0ng-Pass!', 'my-secret-2026', 'aB3$xyz9', 'notweak123', '非常安全的口令2026']) {
  ok(auth.isWeakPassword(p) === false, `强口令通过: ${JSON.stringify(p)}`);
}
ok(auth.isWeakPassword(null) === true, 'null 视为弱口令');
ok(auth.isWeakPassword('x'.repeat(300)) === true, '超长口令视为非法');

console.log('\n=== E. 路由：口令已设置后 /setup 必须跳登录页（不留僵尸表单）===');
{
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(here, '../gateway/index.js'), 'utf8');
  const block = src.slice(src.indexOf("if (pathname === '/setup' && req.method === 'GET')"));
  const body = block.slice(0, block.indexOf('\n  }') + 4);
  ok(/if \(!isSetupRequired\(\)\) \{ res\.writeHead\(302, \{ Location: '\/login' \}\); return res\.end\(\); \}/.test(body),
    '/setup 在口令已设置时 302 到 /login');
  ok(/serveStaticHtml\(res, 'setup\.html'\)/.test(body), '仍保留未设置时的向导渲染');
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
