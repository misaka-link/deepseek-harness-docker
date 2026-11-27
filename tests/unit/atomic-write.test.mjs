#!/usr/bin/env node
/**
 * 原子写回归测试。
 * 用法: node tests/unit/atomic-write.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { writeFileAtomicSync } = require(path.join(root, 'gateway/src/core/atomic-write.js'));

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m + (d ? '  → ' + d : '')); fail++; } };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));

try {
  console.log('\n=== A. 写入内容与权限 ===');
  const f1 = path.join(DIR, 'secret.txt');
  writeFileAtomicSync(f1, 'abc123\n', { mode: 0o600 });
  ok(fs.readFileSync(f1, 'utf8') === 'abc123\n', '内容完整写入');
  ok((fs.statSync(f1).mode & 0o777) === 0o600, '权限位为 0600', (fs.statSync(f1).mode & 0o777).toString(8));
  ok(!fs.readdirSync(DIR).some((n) => n.includes('.tmp-')), '无 .tmp 残留');

  console.log('\n=== B. 覆盖已有文件 ===');
  writeFileAtomicSync(f1, 'new-content', { mode: 0o600 });
  ok(fs.readFileSync(f1, 'utf8') === 'new-content', '整体替换（无旧内容残留）');
  ok((fs.statSync(f1).mode & 0o777) === 0o600, '覆盖后权限仍为 0600');

  console.log('\n=== C. 写入失败不破坏原文件 ===');
  const f2 = path.join(DIR, 'keep.txt');
  fs.writeFileSync(f2, 'original');
  let threw = false;
  try {
    const blocker = path.join(DIR, 'blocker');
    fs.writeFileSync(blocker, 'x');
    writeFileAtomicSync(path.join(blocker, 'sub', 'file.txt'), 'data');
  } catch { threw = true; }
  ok(threw, '异常路径抛出（不静默吞）');
  ok(fs.readFileSync(f2, 'utf8') === 'original', '其它文件未被影响');
  ok(!fs.readdirSync(DIR).some((n) => n.includes('.tmp-')), '失败后无 .tmp 残留');

  console.log('\n=== D. 关键持久化写入必须使用原子写 ===');
  const mustUseAtomic = [
    { file: 'gateway/src/config/gateway-config.js', what: 'gateway.config.json（含 authToken）' },
    { file: 'gateway/src/auth/session.js', what: 'session_secret' },
    { file: 'gateway/src/auth/internal-token.js', what: '内部令牌' },
    { file: 'gateway/src/plugins/plugin-manager.js', what: 'profile / patch 写盘' }
  ];
  for (const { file, what } of mustUseAtomic) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    ok(/writeFileAtomicSync\(/.test(src), `${what} 使用原子写（${file}）`);
  }
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log('\n────────────────────────────────────────');
console.log(fail === 0 ? `✅ 原子写测试通过（${pass}/${pass + fail}）` : `❌ 原子写测试失败：${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
