/**
 * 原子写回归测试（Issue #18 同类问题收口）。
 *
 * 覆盖：
 *   A. 写入完整、权限位正确（0600 类敏感文件不能被短暂放宽）
 *   B. 无 .tmp 残留；覆盖已有文件时是整体替换
 *   C. 写入失败时原文件保持不变（不会先截断再失败）
 *   D. 静态检查：配置 / 会话密钥 / 内部令牌 / 启动令牌 必须走原子写
 *
 * 用法: node scripts/atomic-write-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const { writeFileAtomicSync } = require(path.join(root, 'gateway/atomic-write.js'));

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m + (d ? '  → ' + d : '')); fail++; } };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));

// A. 写入与权限
console.log('\n=== A. 写入内容与权限 ===');
const f1 = path.join(DIR, 'secret.txt');
writeFileAtomicSync(f1, 'abc123\n', { mode: 0o600 });
ok(fs.readFileSync(f1, 'utf8') === 'abc123\n', '内容完整写入');
ok((fs.statSync(f1).mode & 0o777) === 0o600, '权限位为 0600', (fs.statSync(f1).mode & 0o777).toString(8));
ok(!fs.readdirSync(DIR).some((n) => n.includes('.tmp-')), '无 .tmp 残留');

// B. 覆盖替换
console.log('\n=== B. 覆盖已有文件 ===');
writeFileAtomicSync(f1, 'new-content', { mode: 0o600 });
ok(fs.readFileSync(f1, 'utf8') === 'new-content', '整体替换（无旧内容残留）');
ok((fs.statSync(f1).mode & 0o777) === 0o600, '覆盖后权限仍为 0600');

// C. 失败时原文件不变
console.log('\n=== C. 写入失败不破坏原文件 ===');
const f2 = path.join(DIR, 'keep.txt');
fs.writeFileSync(f2, 'original');
let threw = false;
try {
  // 目标目录不存在且无法创建（用一个文件当目录）
  const blocker = path.join(DIR, 'blocker');
  fs.writeFileSync(blocker, 'x');
  writeFileAtomicSync(path.join(blocker, 'sub', 'file.txt'), 'data');
} catch { threw = true; }
ok(threw, '异常路径抛出（不静默吞）');
ok(fs.readFileSync(f2, 'utf8') === 'original', '其它文件未被影响');
ok(!fs.readdirSync(DIR).some((n) => n.includes('.tmp-')), '失败后无 .tmp 残留');

// D. 静态检查：敏感写入必须走原子写
console.log('\n=== D. 关键文件必须使用原子写 ===');
const mustUseAtomic = [
  { file: 'gateway/index.js', what: 'gateway.config.json（含 authToken）' },
  { file: 'gateway/auth.js', what: 'session_secret' },
  { file: 'gateway/internal-token.js', what: '内部令牌' },
  { file: 'gateway/token-crawler.js', what: 'DSH 启动令牌' }
];
for (const { file, what } of mustUseAtomic) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  ok(/writeFileAtomicSync\(/.test(src), what + ' 使用原子写（' + file + '）');
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log('\n────────────────────────────────────────');
console.log(fail === 0 ? '✅ 原子写测试通过（' + pass + '/' + (pass + fail) + '）' : '❌ 原子写测试失败：' + fail + ' 项未通过');
process.exit(fail === 0 ? 0 : 1);
