/**
 * S2 回归测试：快照归档成员白名单校验。
 * 用法: node scripts/backup-archive-validation-test.mjs
 *
 * 会临时构造若干归档（含恶意成员），验证 validateArchiveMembers 的拒绝/放行行为。
 *
 * Issue #8 追加的用例（G/H/I/J/K/L）锁定三条回归：
 *   - 含硬链接的合法快照必须放行（GNU tar 对硬链接打印 ` link to ` / ` 连接到 `，旧代码只认 ` -> `）；
 *   - verbose 清单超过 8 MiB 的合法大快照必须放行（旧代码用 8 MiB 字节上限把正常快照判成「已损坏」）；
 *   - 放宽之后仍然 fail-closed：硬链接目标逃逸、成员嵌在符号链接之下都必须被拒。
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { validateArchiveMembers, classifyArchiveMemberLine } = require(path.join(here, '../gateway/backup-service.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-arch-'));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

function tar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

// ── 手写最小 tar：构造 GNU tar 不便生成的成员（任意硬链接目标 / 符号链接嵌套）────────
const BLOCK = 512;
const octalField = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';

function tarHeader({ name, size, typeflag, linkname }) {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octalField(0o644, 8), 100, 8, 'ascii');   // mode
  buf.write(octalField(0, 8), 108, 8, 'ascii');       // uid
  buf.write(octalField(0, 8), 116, 8, 'ascii');       // gid
  buf.write(octalField(size, 12), 124, 12, 'ascii');  // size
  buf.write(octalField(0, 12), 136, 12, 'ascii');     // mtime
  buf.write('        ', 148, 8, 'ascii');             // chksum 占位（先填空格）
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function writeRawTarGz(file, members) {
  const chunks = [];
  for (const m of members) {
    const data = Buffer.from(m.data ?? '', 'utf8');
    chunks.push(tarHeader({
      name: m.name,
      size: data.length,
      typeflag: m.typeflag ?? '0',
      linkname: m.linkname ?? ''
    }));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
      data.copy(padded);
      chunks.push(padded);
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(chunks)));
}

async function expectReject(file, label, opts) {
  try {
    await validateArchiveMembers(file, opts);
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

  // ================= Issue #8 回归（G/H/I）与放宽后的安全回归（J/K/L）=================

  // ---- G. 硬链接：合法快照必须放行 ----
  const hl = path.join(TMP, 'hl');
  fs.mkdirSync(path.join(hl, '.dsh'), { recursive: true });
  fs.writeFileSync(path.join(hl, '.dsh', 'a.txt'), 'same content\n');
  fs.linkSync(path.join(hl, '.dsh', 'a.txt'), path.join(hl, '.dsh', 'b.txt'));
  const hlTar = path.join(TMP, 'hl.tar.gz');
  tar(['-czf', hlTar, '-C', hl, '.dsh']);
  console.log('\n=== G. 硬链接成员（Issue #8 回归：旧实现 100% 误杀）===');
  try {
    const r = await validateArchiveMembers(hlTar);
    ok(r.hardLinks >= 1, `含硬链接的合法快照放行（成员 ${r.members}，硬链接 ${r.hardLinks}）`);
  } catch (e) { ok(false, '含硬链接的合法快照被误拒: ' + e.message); }

  // ---- H. verbose 清单 > 8 MiB：合法大快照必须放行 ----
  console.log('\n=== H. verbose 清单 > 8 MiB（Issue #8 核心回归：旧实现报「输出超过上限」）===');
  const deepRoot = path.join(TMP, 'deep');
  let deep = path.join(deepRoot, '.dsh', 'profiles', 'web', 'node_modules');
  for (let i = 0; i < 6; i++) deep = path.join(deep, 'pkg-' + 'x'.repeat(200));
  fs.mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 7500; i++) {
    fs.writeFileSync(path.join(deep, `module-${String(i).padStart(5, '0')}-${'y'.repeat(50)}.js`), 'x');
  }
  const bigTar = path.join(TMP, 'big.tar.gz');
  tar(['-czf', bigTar, '-C', deepRoot, '.dsh']);
  try {
    const r = await validateArchiveMembers(bigTar);
    ok(r.listingBytes > 8 * 1024 * 1024,
      `清单 ${(r.listingBytes / 1048576).toFixed(1)} MiB（> 8 MiB）仍放行，成员 ${r.members}`);
  } catch (e) { ok(false, '大快照被误拒: ' + e.message); }

  // ---- I. 成员数上限：可配置且文案不得谎称「文件已损坏」----
  console.log('\n=== I. 成员数上限与文案 ===');
  try {
    await validateArchiveMembers(goodTar, { maxMembers: 2 });
    ok(false, '超过成员数上限却通过了');
  } catch (e) {
    ok(/成员数超过上限/.test(e.message) && !/损坏/.test(e.message),
      '拒绝且文案可分辨（不再说「文件已损坏」）: ' + e.message.slice(0, 46));
  }

  // ---- J. 恶意硬链接目标必须拒绝 ----
  console.log('\n=== J. 恶意硬链接目标（放宽硬链接后的安全回归）===');
  const hlRel = path.join(TMP, 'hlrel.tar.gz');
  writeRawTarGz(hlRel, [{ name: '.dsh/evil', typeflag: '1', linkname: '../../etc/passwd' }]);
  await expectReject(hlRel, '硬链接目标含 `..` 逃逸');
  const hlAbs = path.join(TMP, 'hlabs.tar.gz');
  writeRawTarGz(hlAbs, [{ name: '.dsh/evil', typeflag: '1', linkname: '/etc/passwd' }]);
  await expectReject(hlAbs, '硬链接目标为 `.dsh/` 之外的绝对路径');

  // ---- K. 成员嵌在符号链接之下必须拒绝（纵深防御）----
  console.log('\n=== K. 成员位于符号链接之下 ===');
  const nested = path.join(TMP, 'nested.tar.gz');
  writeRawTarGz(nested, [
    // 软链目标本身落在白名单里，若只看「目标是否合法」会放行整个归档
    { name: '.dsh/link', typeflag: '2', linkname: '/usr/local/lib/node_modules/whatever' },
    { name: '.dsh/link/pwned.txt', typeflag: '0', data: 'PWNED\n' }
  ]);
  await expectReject(nested, '符号链接之下的成员');

  // ---- L. 解析层单元断言 ----
  console.log('\n=== L. 单元级解析断言（名字不被截断 / 两种硬链接文案）===');
  try {
    classifyArchiveMemberLine('drwxr-xr-x root/root 0 2026-01-01 00:00 .dsh/a link to ../../etc');
    ok(false, '目录名里的 `../..` 被截断放行了');
  } catch (e) {
    ok(/非法路径段/.test(e.message), '普通成员名含 ` link to ../..` 不被截断 → 拒绝');
  }
  const cHard = classifyArchiveMemberLine('hrw-r--r-- root/root 0 2026-01-01 00:00 .dsh/a.txt link to .dsh/b.txt');
  ok(cHard && cHard.type === 'hardlink' && cHard.name === '.dsh/a.txt', 'C locale 硬链接文案可解析');
  const zHard = classifyArchiveMemberLine('hrw-r--r-- root/root 0 2026-01-01 00:00 .dsh/a.txt 连接到 .dsh/b.txt');
  ok(zHard && zHard.type === 'hardlink' && zHard.name === '.dsh/a.txt', 'zh_CN 硬链接文案可解析');
  const fileWithArrow = classifyArchiveMemberLine('-rw-r--r-- root/root 1 2026-01-01 00:00 .dsh/a -> b.txt');
  ok(fileWithArrow && fileWithArrow.name === '.dsh/a -> b.txt', '普通成员名含 ` -> ` 时不被截断');

  // ---- M. 指向「本归档自身根」的绝对软链（.dsh-module-fallback 的真实形态）----
  console.log('\n=== M. 绝对软链指向归档自身根目录（旧实现整包拒收）===');
  const dshHome = process.env.DSH_HOME || '/root';
  const dshAbs = (rel) => path.posix.join(dshHome, '.dsh', rel);
  const mfTar = path.join(TMP, 'module-fallback.tar.gz');
  writeRawTarGz(mfTar, [{
    name: '.dsh/profiles/web/.dsh-module-fallback/node_modules/d3-hiera',
    typeflag: '2',
    linkname: dshAbs('profiles/web/node_modules/d3-hiera')
  }]);
  try {
    const r = await validateArchiveMembers(mfTar);
    ok(r.symLinks === 1, '指向 <DSH_HOME>/.dsh/... 的软链放行（真实老快照必备）');
  } catch (e) { ok(false, '指向归档自身根的软链被误拒: ' + e.message); }

  const mfEscTar = path.join(TMP, 'module-fallback-esc.tar.gz');
  writeRawTarGz(mfEscTar, [{
    name: '.dsh/profiles/web/.dsh-module-fallback/node_modules/d3-hiera',
    typeflag: '2',
    linkname: `${dshHome}/.dsh/../../../etc/passwd`   // 归一化后逃出 .dsh/
  }]);
  await expectReject(mfEscTar, '归档根下的软链用 `..` 逃出 .dsh/');

  // ============ 以下用例来自独立对抗性验证（doc/issue-8/verification-adversarial.md）============

  // ---- N. 软链目标前缀回溯：必须先归一化再比对白名单前缀 ----
  console.log('\n=== N. 软链目标前缀回溯（`/opt/../etc/passwd`）===');
  const pfx1 = path.join(TMP, 'pfx1.tar.gz');
  writeRawTarGz(pfx1, [{ name: '.dsh/link', typeflag: '2', linkname: '/opt/../etc/passwd' }]);
  await expectReject(pfx1, '经归一化后逃出 /opt/ 的软链目标');
  const pfx2 = path.join(TMP, 'pfx2.tar.gz');
  writeRawTarGz(pfx2, [{ name: '.dsh/link', typeflag: '2', linkname: '/app/plugins/../../etc/shadow' }]);
  await expectReject(pfx2, '经归一化后逃出 /app/plugins/ 的软链目标');
  const pfxOk = path.join(TMP, 'pfxok.tar.gz');
  writeRawTarGz(pfxOk, [{ name: '.dsh/link', typeflag: '2', linkname: '/opt/x/../y' }]);
  try {
    await validateArchiveMembers(pfxOk);
    ok(true, '归一化后仍落在 /opt/ 之内的目标照常放行（未误伤）');
  } catch (e) { ok(false, '合法的 /opt 目标被误拒: ' + e.message); }

  // ---- O. 链接分隔符注入：名字里含 ` -> ` 时不得被贪婪切分 ----
  console.log('\n=== O. 成员名注入 ` -> ` 欺骗解析器 ===');
  const inj = path.join(TMP, 'inject.tar.gz');
  writeRawTarGz(inj, [{ name: '.dsh/leak -> dummy', typeflag: '2', linkname: '/etc/passwd' }]);
  await expectReject(inj, '名字含 ` -> ` 的软链（分隔符歧义 → fail-closed）');

  // ---- P. 硬链接继承符号链接语义 ----
  console.log('\n=== P. 硬链接指向软链后跟子成员 ===');
  const hlSym = path.join(TMP, 'hlsym.tar.gz');
  writeRawTarGz(hlSym, [
    { name: '.dsh/sym', typeflag: '2', linkname: '/usr/local/lib/node_modules/ok' },
    { name: '.dsh/h4', typeflag: '1', linkname: '.dsh/sym' },
    { name: '.dsh/h4/evil.txt', typeflag: '0', data: 'x' }
  ]);
  await expectReject(hlSym, '经硬链接继承的软链之下的成员');

  // ---- Q. 逆序嵌套：单遍流式无法预知「后面的」软链，靠解压步骤 fail-closed 兜住 ----
  console.log('\n=== Q. 逆序嵌套（先子成员、后软链）的补偿性控制 ===');
  const rev = path.join(TMP, 'reverse.tar.gz');
  writeRawTarGz(rev, [
    { name: '.dsh/link/pwned.txt', typeflag: '0', data: 'PWNED\n' },
    { name: '.dsh/link', typeflag: '2', linkname: '/usr/local/lib/node_modules/ok' }
  ]);
  let revAccepted = false;
  try { await validateArchiveMembers(rev); revAccepted = true; } catch { /* 预期之外地被拒也行 */ }
  const stage = path.join(TMP, 'revstage');
  fs.mkdirSync(stage, { recursive: true });
  const extract = tar(['-xzf', rev, '-C', stage]);
  ok(extract.status !== 0,
    `校验层放行=${revAccepted}，但 tar 解压必须失败（restore 随即回滚）: exit=${extract.status}`);

  // ---- R. 归档根目录本身不得是链接成员（第二轮对抗验证发现）----
  console.log('\n=== R. `.dsh` 本身被伪造成软链 ===');
  const rootLink = path.join(TMP, 'rootlink.tar.gz');
  writeRawTarGz(rootLink, [{ name: '.dsh', typeflag: '2', linkname: '/opt/my-tool' }]);
  await expectReject(rootLink, '归档根 `.dsh` 是软链');
  const rootLinkSlash = path.join(TMP, 'rootlinkslash.tar.gz');
  writeRawTarGz(rootLinkSlash, [{ name: '.dsh/', typeflag: '2', linkname: '/opt/my-tool' }]);
  await expectReject(rootLinkSlash, '归档根 `.dsh/` 是软链');
  const rootDir = path.join(TMP, 'rootdir.tar.gz');
  writeRawTarGz(rootDir, [{ name: '.dsh/', typeflag: '5' }]);
  try {
    await validateArchiveMembers(rootDir);
    ok(true, '正常的 `.dsh/` 目录成员照常放行（未误伤）');
  } catch (e) { ok(false, '正常的 `.dsh/` 目录成员被误拒: ' + e.message); }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
