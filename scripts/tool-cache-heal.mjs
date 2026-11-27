#!/usr/bin/env node
/**
 * 工具缓存自愈 CLI：npx 缓存 + pnpm dlx 缓存。
 *
 * 用法:
 *   node scripts/tool-cache-heal.mjs               # 修复（静默 120s 才算中断）
 *   node scripts/tool-cache-heal.mjs --boot        # 启动期：不设静默期
 *   node scripts/tool-cache-heal.mjs --dry-run     # 只诊断
 *   node scripts/tool-cache-heal.mjs --json        # 机器可读
 *   node scripts/tool-cache-heal.mjs --tool npx    # 只处理某一类（npx | pnpm-dlx | all）
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const npxMod = require(path.join(here, '../gateway/src/maintenance/npx-cache.js'));
const dlxMod = require(path.join(here, '../gateway/src/maintenance/pnpm-dlx-cache.js'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const dryRun = has('--dry-run');
const json = has('--json');
const quiet = has('--quiet');
const boot = has('--boot');
const tool = (valueOf('--tool') || 'all').trim();
const cacheArg = valueOf('--cache');
const quietMsArg = Number(valueOf('--quiet-ms'));
const quietMs = boot ? 0 : (Number.isFinite(quietMsArg) && quietMsArg >= 0 ? quietMsArg : 120000);

const runNpx = tool === 'all' || tool === 'npx';
const runDlx = tool === 'all' || tool === 'pnpm-dlx';

const out = {};
try {
  if (runNpx) {
    out.npx = npxMod.healNpxCache({
      cacheDir: cacheArg || npxMod.resolveNpmCacheDir(),
      dryRun,
      quietMs
    });
  }
  if (runDlx) {
    const dlxCache = valueOf('--dlx-cache') || dlxMod.resolvePnpmCacheDir();
    out.pnpmDlx = dlxMod.healPnpmDlxCache({ cacheDir: dlxCache, dryRun, quietMs });
  }
} catch (e) {
  console.error('[tool-cache-heal] 执行失败:', e && e.message);
  process.exit(1);
}

if (json) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

const total = (k) => Object.values(out).reduce((n, r) => n + (r[k] || 0), 0);
const changed = total('repaired') + total('removed');

if (changed === 0) {
  if (!quiet) {
    const scanned = total('scanned');
    if (scanned > 0) {
      console.log(`[tool-cache-heal] 检查 ${scanned} 个缓存目录，无需修复（健康 ${total('healthy')} / 跳过 ${total('skipped')}）`);
    }
  }
  process.exit(0);
}

for (const [kind, r] of Object.entries(out)) {
  const label = kind === 'npx' ? 'npx' : 'pnpm dlx';
  console.log(`[tool-cache-heal] ${label} 缓存: ${r.cacheDir}`);
  console.log(`[tool-cache-heal] ${label}：${dryRun ? '[演练] 将修复' : '已修复'} ${r.repaired} 个、清理 ${r.removed} 个（扫描 ${r.scanned} / 跳过 ${r.skipped} / 错误 ${r.errors}）`);
  for (const a of r.actions) {
    if (a.action === 'repaired' || a.action === 'would-repair') {
      const deps = Object.entries(a.dependencies || {}).map(([n, v]) => `${n}@${v}`).join(', ');
      console.log(`   · ${path.basename(a.dir)}  ← 依据 ${a.source} 补写清单: ${deps}`);
    } else if (a.action === 'remove') {
      console.log(`   · ${path.basename(a.dir)}  ← 清理: ${a.reason}`);
    } else if (a.action === 'error') {
      console.error(`   · ${path.basename(a.dir)}  ← 失败: ${a.reason}`);
    }
  }
}
process.exit(0);
