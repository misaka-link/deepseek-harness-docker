/**
 * S2 回归测试：快照归档成员白名单校验。
 * 用法: node scripts/backup-archive-validation-test.mjs
 *
 * 会临时构造若干归档（含恶意成员），验证 validateArchiveMembers 的拒绝/放行行为。
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { validateArchiveMembers } = require(path.join(here, '../gateway/backup-service.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-arch-'));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

function tar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

async function expectReject(file, label) {
  try {
    await validateArchiveMembers(file);
    ok(false, `${label}（本应被拒，却通过了）`);
  } catch (e) {
    ok(true, `${label} → 拒绝: ${e.message.slice(0, 60)}`);
  }
}

async function main() {
  // ---- 正常归档：.dsh/ 之下 ----
  const good = path.join(TMP, 'good');
  fs.mkdirSync(path.join(good, '.dsh', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(good, '.dsh', 'settings.yaml'), 'a: 1\n');
  fs.writeFileSync(path.join(good, '.dsh', 'profiles', 'web.json'), '{}\n');
  const goodTar = path.join(TMP, 'good.tar.gz');
  tar(['-czf', goodTar, '-C', good, '.dsh']);

  console.log('\n=== A. 正常快照应通过 ===');
  try {
    const r = await validateArchiveMembers(goodTar);
    ok(r.members >= 3, `正常归档通过（成员数 ${r.members}）`);
  } catch (e) { ok(false, '正常归档被误拒: ' + e.message); }

  // ---- 恶意 1：成员位于 .dsh/ 之外（.ssh/authorized_keys）----
  const esc = path.join(TMP, 'esc');
  fs.mkdirSync(path.join(esc, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(esc, '.ssh', 'authorized_keys'), 'ssh-rsa AAAA\n');
  const escTar = path.join(TMP, 'esc.tar.gz');
  tar(['-czf', escTar, '-C', esc, '.ssh']);
  console.log('\n=== B. 越界成员（.ssh/authorized_keys）===');
  await expectReject(escTar, '超出 .dsh/ 前缀的成员');

  // ---- 恶意 2：绝对路径成员 ----
  fs.writeFileSync(path.join(TMP, 'abs.txt'), 'x\n');
  const absTar = path.join(TMP, 'abs.tar.gz');
  tar(['-czPf', absTar, '-C', TMP, path.join(TMP, 'abs.txt')]);
  console.log('\n=== C. 绝对路径成员 ===');
  await expectReject(absTar, '绝对路径成员');

  // ---- 恶意 3：符号链接成员 ----
  const sl = path.join(TMP, 'sl');
  fs.mkdirSync(path.join(sl, '.dsh'), { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(sl, '.dsh', 'link'));
  const slTar = path.join(TMP, 'sl.tar.gz');
  tar(['-czf', slTar, '-C', sl, '.dsh']);
  console.log('\n=== D. 符号链接成员 ===');
  await expectReject(slTar, '符号链接成员');

  // ---- 恶意 4：`..` 路径段（用 transform 构造，构造不出则跳过）----
  const dd = path.join(TMP, 'dd');
  fs.mkdirSync(path.join(dd, '.dsh'), { recursive: true });
  fs.writeFileSync(path.join(dd, '.dsh', 'evil'), 'x\n');
  const ddTar = path.join(TMP, 'dd.tar.gz');
  const ddRes = tar(['-czf', ddTar, '--transform=s|^\\.dsh/|.dsh/../|', '-C', dd, '.dsh/evil']);
  console.log('\n=== E. `..` 路径段 ===');
  if (ddRes.status === 0 && fs.existsSync(ddTar)) {
    await expectReject(ddTar, '包含 .. 段的成员');
  } else {
    console.log('   （tar 拒绝构造 .. 成员，跳过该用例）');
  }

  // ---- 合法：指向依赖安装位置的软链（本项目快照真实存在）----
  const okLink = path.join(TMP, 'oklink');
  fs.mkdirSync(path.join(okLink, '.dsh', 'profiles', 'web', 'node_modules'), { recursive: true });
  fs.symlinkSync('/usr/local/lib/node_modules/dshmarket', path.join(okLink, '.dsh', 'profiles', 'web', 'node_modules', 'dshmarket'));
  const okLinkTar = path.join(TMP, 'oklink.tar.gz');
  tar(['-czf', okLinkTar, '-C', okLink, '.dsh']);
  console.log('\n=== D2. 合法软链（指向依赖安装位置）应放行 ===');
  try {
    const r2 = await validateArchiveMembers(okLinkTar);
    ok(r2.members >= 1, `合法软链放行（成员数 ${r2.members}）`);
  } catch (e) { ok(false, '合法软链被误拒: ' + e.message); }

  // ---- 恶意 5：损坏/非归档文件 ----
  const broken = path.join(TMP, 'broken.tar.gz');
  fs.writeFileSync(broken, 'not a gzip');
  console.log('\n=== F. 损坏文件 ===');
  await expectReject(broken, '损坏/非归档文件');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
