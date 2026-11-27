#!/usr/bin/env node
/**
 * 空口令初始化向导状态机与口令强度校验单元测试。
 * 用法: node tests/unit/setup-gate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-setup-gate-'));
process.env.DSH_HOME = tmpDir;
process.env.DSH_DIR = path.join(tmpDir, '.dsh');
process.env.SESSION_SECRET_FILE = path.join(tmpDir, '.dsh/.session_secret');
process.env.AUTH_TOKEN = '';
process.env.ACCESS_CODE = '';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const session = require(path.join(root, 'gateway/src/auth/session.js'));
const setupGate = require(path.join(root, 'gateway/src/auth/setup-gate.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

try {
  ok(session.isAuthEnabled() === false && setupGate.isSetupRequired() === true, 'A. 空口令需要初始化向导');

  session.updateAuthToken('Str0ng-Pass!');
  ok(session.isAuthEnabled() === true && setupGate.isSetupRequired() === false, 'B1. 设置口令后关闭初始化向导');
  ok(session.verifyToken('Str0ng-Pass!') === true && session.verifyToken('wrong') === false, 'B2. 新口令校验通过、错口令被拒');

  session.updateAuthToken('');
  ok(setupGate.isSetupRequired() === true, 'C. 清除口令回到初始化向导');

  for (const p of ['admin', 'Admin', 'password', '123456', '12345678', 'qwertyuiop', 'short', '', '   ', 'deepseek', 'letmein', '111111', null, 'x'.repeat(300)]) {
    ok(setupGate.isWeakPassword(p) === true, `D. 弱/非法口令被拒: ${JSON.stringify(p)?.slice(0, 24)}`);
  }
  for (const p of ['Str0ng-Pass!', 'my-secret-2026', 'aB3$xyz9', 'notweak123', '非常安全的口令2026', 'aB3$x9', 'pass6!']) {
    ok(setupGate.isWeakPassword(p) === false, `D. 强口令放行: ${JSON.stringify(p)}`);
  }

  const pubAuthSrc = fs.readFileSync(path.join(root, 'gateway/src/routes/public-auth.js'), 'utf8');
  ok(
    /if \(!setupGate\.isSetupRequired\(\)\)\s*\{\s*\n\s*sendRedirect\(res, '\/login'\)/.test(pubAuthSrc) &&
    /renderTemplate\(req, res, 'setup'/.test(pubAuthSrc),
    'E. public-auth.js 在口令已设置时 /setup 302 跳转 /login，否则渲染 setup 模板'
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
