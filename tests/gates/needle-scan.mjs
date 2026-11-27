#!/usr/bin/env node
/**
 * needle-scan.mjs — Gate test for scripts/lib/needle-scan.mjs and repo plugins/.
 *
 * Verifies:
 *   1) Unpatched client bundles with loopback/memory needles are detected (non-zero CLI exit).
 *   2) Patched bundles pass with 0 residues (exit 0) and .dsh-orig backups are ignored.
 *   3) Built-in plugins/ directory in the repository has 0 needle residues.
 *
 * Usage: node tests/gates/needle-scan.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NEEDLES, scanDirectory } from '../../scripts/lib/needle-scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cliScript = path.join(root, 'scripts/lib/needle-scan.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) {
    console.log('   ✔ ' + msg);
    pass++;
  } else {
    console.log('   ❌ ' + msg + (detail ? '  → ' + detail : ''));
    fail++;
  }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-needle-gate-'));

try {
  console.log('\n=== A. 沙箱未修补残留检出 ===');
  const pkgDir = path.join(tmpRoot, 'dsh-client-remote-connection/lib');
  fs.mkdirSync(pkgDir, { recursive: true });
  const browserFile = path.join(pkgDir, 'client.browser.js');
  const rawCode = [
    'const isLoop = isLoopbackHostname(pageLocation.hostname);',
    'const mode = connection.isLoopback ? "host" : "memory";',
    'export { isLoop, mode };'
  ].join('\n');
  fs.writeFileSync(browserFile, rawCode, 'utf8');
  // Backup file should be ignored by scanner
  fs.writeFileSync(browserFile + '.dsh-orig', rawCode, 'utf8');

  const unpatchedScan = scanDirectory(tmpRoot);
  ok(
    unpatchedScan.residues.length === 2,
    'scanDirectory 准确检出 2 处未修补 needle（并跳过 .dsh-orig）',
    `actual=${unpatchedScan.residues.length}`
  );

  const cliFail = spawnSync(process.execPath, [cliScript, '--dir', tmpRoot, '--json'], { encoding: 'utf8' });
  ok(cliFail.status !== 0, 'CLI 在存在残留时返回非零退出码', `status=${cliFail.status}`);
  const failReport = JSON.parse(cliFail.stdout || '{}');
  ok(failReport.ok === false && failReport.needleResidue === 2, 'CLI JSON 报告 needleResidue === 2');

  console.log('\n=== B. 修补后零残留放行 ===');
  fs.writeFileSync(
    browserFile,
    'const isLoop = true;\nconst mode = "host";\nexport { isLoop, mode };\n/* dsh-patch: loopback-host-mode-applied */\n',
    'utf8'
  );
  const patchedScan = scanDirectory(tmpRoot);
  ok(patchedScan.residues.length === 0, '修补后 scanDirectory 返回 0 处残留');

  const cliPass = spawnSync(process.execPath, [cliScript, '--build', '--dir', tmpRoot, '--json'], { encoding: 'utf8' });
  ok(cliPass.status === 0, 'CLI --build 在零残留时退出码为 0', `status=${cliPass.status}`);
  const passReport = JSON.parse(cliPass.stdout || '{}');
  ok(passReport.ok === true && passReport.needleResidue === 0, 'CLI JSON 报告 ok=true, needleResidue=0');

  console.log('\n=== C. 仓库 plugins/ 目录零残留校验 ===');
  const pluginsDir = path.join(root, 'plugins');
  const pluginsScan = scanDirectory(pluginsDir);
  ok(NEEDLES.length >= 2, `扫描针集包含 ${NEEDLES.length} 条关键模式`);
  ok(
    pluginsScan.residues.length === 0,
    `仓库 plugins/ 扫描 ${pluginsScan.filesScanned} 个 JS 文件无未修补残留`,
    pluginsScan.residues.map((r) => `${r.file}:${r.needle}`).join(' | ')
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ Needle 残留扫描门禁通过（${pass}/${pass + fail}）`
    : `❌ Needle 残留扫描门禁失败：${fail} 项未通过 / 共 ${pass + fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
