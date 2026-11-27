#!/usr/bin/env node
/**
 * 快照归档成员白名单校验与历史软链修复回归测试。
 * 用法: node tests/unit/backup-archive-validation.test.mjs
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
const root = path.resolve(here, '../..');
const {
  validateArchiveMembers,
  classifyArchiveMemberLine,
  repairEscapingRelativeLinks,
  hasPigz,
  getPigzThreads,
  buildTarEnv
} = require(path.join(root, 'gateway/src/backup/index.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-arch-'));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

function tar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

const BLOCK = 512;
const octalField = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';

function tarHeader({ name, size, typeflag, linkname }) {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octalField(0o644, 8), 100, 8, 'ascii');
  buf.write(octalField(0, 8), 108, 8, 'ascii');
  buf.write(octalField(0, 8), 116, 8, 'ascii');
  buf.write(octalField(size, 12), 124, 12, 'ascii');
  buf.write(octalField(0, 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
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
  try {
    const good = path.join(TMP, 'good');
    fs.mkdirSync(path.join(good, '.dsh', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(good, '.dsh', 'settings.yaml'), 'a: 1\n');
    fs.writeFileSync(path.join(good, '.dsh', 'profiles', 'web.json'), '{}\n');
    const goodTar = path.join(TMP, 'good.tar.gz');
    tar(['-czf', goodTar, '-C', good, '.dsh']);

    console.log('\n=== A. 正常快照应通过 ===');
    const rGood = await validateArchiveMembers(goodTar);
    ok(rGood.members >= 3, `正常归档通过（成员数 ${rGood.members}）`);

    console.log('\n=== B. 越界成员（.ssh/authorized_keys）===');
    const esc = path.join(TMP, 'esc');
    fs.mkdirSync(path.join(esc, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(esc, '.ssh', 'authorized_keys'), 'ssh-rsa AAAA\n');
    const escTar = path.join(TMP, 'esc.tar.gz');
    tar(['-czf', escTar, '-C', esc, '.ssh']);
    await expectReject(escTar, '超出 .dsh/ 前缀的成员');

    console.log('\n=== C. 绝对路径成员 ===');
    fs.writeFileSync(path.join(TMP, 'abs.txt'), 'x\n');
    const absTar = path.join(TMP, 'abs.tar.gz');
    tar(['-czPf', absTar, '-C', TMP, path.join(TMP, 'abs.txt')]);
    await expectReject(absTar, '绝对路径成员');

    console.log('\n=== D. 恶意/合法符号链接成员 ===');
    const sl = path.join(TMP, 'sl');
    fs.mkdirSync(path.join(sl, '.dsh'), { recursive: true });
    fs.symlinkSync('/etc/passwd', path.join(sl, '.dsh', 'link'));
    const slTar = path.join(TMP, 'sl.tar.gz');
    tar(['-czf', slTar, '-C', sl, '.dsh']);
    await expectReject(slTar, '指向 /etc/passwd 的符号链接');

    const okLink = path.join(TMP, 'oklink');
    fs.mkdirSync(path.join(okLink, '.dsh', 'profiles', 'web', 'node_modules'), { recursive: true });
    fs.symlinkSync('/usr/local/lib/node_modules/dshmarket', path.join(okLink, '.dsh', 'profiles', 'web', 'node_modules', 'dshmarket'));
    const okLinkTar = path.join(TMP, 'oklink.tar.gz');
    tar(['-czf', okLinkTar, '-C', okLink, '.dsh']);
    const rOkLink = await validateArchiveMembers(okLinkTar);
    ok(rOkLink.members >= 1, `指向依赖白名单的合法软链放行（成员数 ${rOkLink.members}）`);

    console.log('\n=== E/F. 路径穿越与损坏归档 ===');
    const ddTar = path.join(TMP, 'dd.tar.gz');
    writeRawTarGz(ddTar, [{ name: '.dsh/../evil', typeflag: '0', data: 'x' }]);
    await expectReject(ddTar, '包含 .. 段的成员');
    const broken = path.join(TMP, 'broken.tar.gz');
    fs.writeFileSync(broken, 'not a gzip');
    await expectReject(broken, '损坏/非归档文件');

    console.log('\n=== G/H/I. 硬链接、大清单 (>8 MiB) 与成员数上限 ===');
    const hl = path.join(TMP, 'hl');
    fs.mkdirSync(path.join(hl, '.dsh'), { recursive: true });
    fs.writeFileSync(path.join(hl, '.dsh', 'a.txt'), 'same content\n');
    fs.linkSync(path.join(hl, '.dsh', 'a.txt'), path.join(hl, '.dsh', 'b.txt'));
    const hlTar = path.join(TMP, 'hl.tar.gz');
    tar(['-czf', hlTar, '-C', hl, '.dsh']);
    const rHl = await validateArchiveMembers(hlTar);
    ok(rHl.hardLinks >= 1, `含硬链接的合法快照放行（硬链接 ${rHl.hardLinks}）`);

    const deepRoot = path.join(TMP, 'deep');
    let deep = path.join(deepRoot, '.dsh', 'profiles', 'web', 'node_modules');
    for (let i = 0; i < 6; i++) deep = path.join(deep, 'pkg-' + 'x'.repeat(200));
    fs.mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 7500; i++) {
      fs.writeFileSync(path.join(deep, `module-${String(i).padStart(5, '0')}-${'y'.repeat(50)}.js`), 'x');
    }
    const bigTar = path.join(TMP, 'big.tar.gz');
    tar(['-czf', bigTar, '-C', deepRoot, '.dsh']);
    const rBig = await validateArchiveMembers(bigTar);
    ok(rBig.listingBytes > 8 * 1024 * 1024, `verbose 清单 ${(rBig.listingBytes / 1048576).toFixed(1)} MiB (> 8 MiB) 正常放行`);

    try {
      await validateArchiveMembers(goodTar, { maxMembers: 2 });
      ok(false, '超过成员数上限却通过了');
    } catch (e) {
      ok(/成员数超过上限/.test(e.message) && !/损坏/.test(e.message), '超过成员数上限提示清晰');
    }

    console.log('\n=== J/K/L/M/N/O/P/Q/R. 对抗边界校验 ===');
    const hlRel = path.join(TMP, 'hlrel.tar.gz');
    writeRawTarGz(hlRel, [{ name: '.dsh/evil', typeflag: '1', linkname: '../../etc/passwd' }]);
    await expectReject(hlRel, '硬链接目标含 .. 逃逸');

    const hlAbs = path.join(TMP, 'hlabs.tar.gz');
    writeRawTarGz(hlAbs, [{ name: '.dsh/evil', typeflag: '1', linkname: '/etc/passwd' }]);
    await expectReject(hlAbs, '硬链接目标为绝对越界路径');

    const nested = path.join(TMP, 'nested.tar.gz');
    writeRawTarGz(nested, [
      { name: '.dsh/link', typeflag: '2', linkname: '/usr/local/lib/node_modules/whatever' },
      { name: '.dsh/link/pwned.txt', typeflag: '0', data: 'PWNED\n' }
    ]);
    await expectReject(nested, '普通成员位于符号链接之下');

    try {
      classifyArchiveMemberLine('drwxr-xr-x root/root 0 2026-01-01 00:00 .dsh/a link to ../../etc');
      ok(false, '目录名里的 ../.. 被放行了');
    } catch (e) {
      ok(/非法路径段/.test(e.message), '普通成员名含 link to ../.. 不被截断');
    }
    const cHard = classifyArchiveMemberLine('hrw-r--r-- root/root 0 2026-01-01 00:00 .dsh/a.txt link to .dsh/b.txt');
    ok(cHard && cHard.type === 'hardlink' && cHard.name === '.dsh/a.txt', 'C locale 硬链接解析');
    const zHard = classifyArchiveMemberLine('hrw-r--r-- root/root 0 2026-01-01 00:00 .dsh/a.txt 连接到 .dsh/b.txt');
    ok(zHard && zHard.type === 'hardlink' && zHard.name === '.dsh/a.txt', 'zh_CN 硬链接解析');

    const dshHome = process.env.DSH_HOME || '/root';
    const mfTar = path.join(TMP, 'module-fallback.tar.gz');
    writeRawTarGz(mfTar, [{
      name: '.dsh/profiles/web/.dsh-module-fallback/node_modules/d3-hiera',
      typeflag: '2',
      linkname: path.posix.join(dshHome, '.dsh', 'profiles/web/node_modules/d3-hiera')
    }]);
    ok((await validateArchiveMembers(mfTar)).symLinks === 1, '指向归档自身根的绝对软链放行');

    const pfx1 = path.join(TMP, 'pfx1.tar.gz');
    writeRawTarGz(pfx1, [{ name: '.dsh/link', typeflag: '2', linkname: '/opt/../etc/passwd' }]);
    await expectReject(pfx1, '归一化后逃出 /opt/ 的软链目标');

    const inj = path.join(TMP, 'inject.tar.gz');
    writeRawTarGz(inj, [{ name: '.dsh/leak -> dummy', typeflag: '2', linkname: '/etc/passwd' }]);
    await expectReject(inj, '软链名含分隔符歧义 fail-closed');

    const hlSym = path.join(TMP, 'hlsym.tar.gz');
    writeRawTarGz(hlSym, [
      { name: '.dsh/sym', typeflag: '2', linkname: '/usr/local/lib/node_modules/ok' },
      { name: '.dsh/h4', typeflag: '1', linkname: '.dsh/sym' },
      { name: '.dsh/h4/evil.txt', typeflag: '0', data: 'x' }
    ]);
    await expectReject(hlSym, '经硬链接继承的软链之下成员');

    const rootLink = path.join(TMP, 'rootlink.tar.gz');
    writeRawTarGz(rootLink, [{ name: '.dsh', typeflag: '2', linkname: '/opt/my-tool' }]);
    await expectReject(rootLink, '归档根 .dsh 本身不得为软链');

    console.log('\n=== S/T. 历史相对软链放行、改写与跨 DSH_HOME 绝对软链重定位 ===');
    const relDshmarket = '../../../../../usr/local/lib/node_modules/dshmarket';
    const relOk = path.join(TMP, 'rel-ok.tar.gz');
    writeRawTarGz(relOk, [
      { name: '.dsh/', typeflag: '5' },
      { name: '.dsh/profiles/web/node_modules/dshmarket', typeflag: '2', linkname: relDshmarket }
    ]);
    ok((await validateArchiveMembers(relOk)).symLinks === 1, '逃出归档根但命中依赖白名单的相对软链放行');

    const relEtc = path.join(TMP, 'rel-etc.tar.gz');
    writeRawTarGz(relEtc, [
      { name: '.dsh/', typeflag: '5' },
      { name: '.dsh/profiles/web/node_modules/evil', typeflag: '2', linkname: '../../../../../etc/passwd' }
    ]);
    await expectReject(relEtc, '相对逃逸指向 /etc/passwd');

    const repairRoot = path.join(TMP, 'repair-stage', '.dsh');
    const dshmarketPath = path.join(repairRoot, 'profiles/web/node_modules/dshmarket');
    fs.mkdirSync(path.dirname(dshmarketPath), { recursive: true });
    fs.symlinkSync(relDshmarket, dshmarketPath);
    const evilLinkPath = path.join(repairRoot, 'evil');
    fs.symlinkSync('../../../../etc/passwd', evilLinkPath);
    const innerLinkPath = path.join(repairRoot, 'profiles/web/node_modules/.bin/katex');
    fs.mkdirSync(path.dirname(innerLinkPath), { recursive: true });
    fs.symlinkSync('../katex/cli.js', innerLinkPath);
    // 跨 DSH_HOME 绝对软链（老 /root/.dsh/... 在自定义 DSH_HOME 下自动重定位）
    const legacyAbsPath = path.join(repairRoot, 'profiles/web/.dsh-module-fallback/mod-a');
    fs.mkdirSync(path.dirname(legacyAbsPath), { recursive: true });
    fs.symlinkSync('/root/.dsh/profiles/web/node_modules/mod-a', legacyAbsPath);

    const oldHome = process.env.DSH_HOME;
    const oldDshDir = process.env.DSH_DIR;
    process.env.DSH_HOME = '/home/dsh';
    delete process.env.DSH_DIR;
    const rep = repairEscapingRelativeLinks(repairRoot);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldDshDir === undefined) delete process.env.DSH_DIR; else process.env.DSH_DIR = oldDshDir;

    ok(fs.readlinkSync(dshmarketPath) === '/usr/local/lib/node_modules/dshmarket', '白名单逃逸相对软链改写为绝对软链');
    ok(fs.readlinkSync(evilLinkPath) === '../../../../etc/passwd', '非白名单逃逸软链保持原样（fail-closed）');
    ok(fs.readlinkSync(innerLinkPath) === '../katex/cli.js', '归档内部相对软链保持原样');
    ok(fs.readlinkSync(legacyAbsPath) === '/home/dsh/.dsh/profiles/web/node_modules/mod-a', '历史 /root/.dsh 绝对软链自动重定位到当前 DSH_HOME');
    ok(rep.relocated >= 1, `relocated 计数正确 (${rep.relocated})`);

    console.log('\n=== U. pigz 纯 Node 探测与有界多线程环境变量 ===');
    const emptyBin = path.join(TMP, 'bin-empty');
    fs.mkdirSync(emptyBin, { recursive: true });
    ok(hasPigz({ pathEnv: emptyBin }) === false, 'hasPigz 在空 PATH 下返回 false');

    const nonExecBin = path.join(TMP, 'bin-nonexec');
    fs.mkdirSync(nonExecBin, { recursive: true });
    fs.writeFileSync(path.join(nonExecBin, 'pigz'), '#!/bin/sh\n', { mode: 0o644 });
    ok(hasPigz({ pathEnv: nonExecBin }) === false, 'hasPigz 忽略不可执行 pigz 文件');

    const execBin = path.join(TMP, 'bin-exec');
    fs.mkdirSync(execBin, { recursive: true });
    fs.writeFileSync(path.join(execBin, 'pigz'), '#!/bin/sh\n', { mode: 0o755 });
    ok(hasPigz({ pathEnv: execBin }) === true, 'hasPigz 命中可执行 pigz 返回 true');

    const defaultThreads = getPigzThreads({});
    ok(Number.isInteger(defaultThreads) && defaultThreads >= 1 && defaultThreads <= 8, `默认 pigz 线程数有界 (${defaultThreads} in 1..8)`);
    ok(getPigzThreads({ DSH_BACKUP_THREADS: '4' }) === 4, 'DSH_BACKUP_THREADS=4 生效');
    ok(getPigzThreads({ DSH_BACKUP_THREADS: '128' }) === 64, 'DSH_BACKUP_THREADS 超上限时钳位至 64');
    ok(getPigzThreads({ DSH_BACKUP_THREADS: '0' }) === defaultThreads, 'DSH_BACKUP_THREADS=0 回落默认值');
    ok(getPigzThreads({ DSH_BACKUP_THREADS: 'invalid' }) === defaultThreads, '非法 DSH_BACKUP_THREADS 回落默认值');

    const envAuto = buildTarEnv({ LC_ALL: 'C' }, { DSH_BACKUP_THREADS: '3' });
    ok(envAuto.PIGZ === '-p 3' && envAuto.LC_ALL === 'C', 'buildTarEnv 注入有界 PIGZ 参数并合并 extraEnv');
    const envExplicit = buildTarEnv({}, { PIGZ: '-p 2 -1', DSH_BACKUP_THREADS: '6' });
    ok(envExplicit.PIGZ === '-p 2 -1', 'buildTarEnv 保留用户显式设置的 PIGZ');
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
