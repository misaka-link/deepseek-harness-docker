#!/usr/bin/env node
/**
 * tests/run.mjs — Unified test & gate runner for deepseek-harness-docker.
 *
 * Runs:
 *   1. tests/gates/*    (version sync, 8-lang i18n parity, UI safety, needle scan, unreleased check)
 *   2. tests/contract/* (golden cookie, dual-schema version.json, real HTTP gateway E2E)
 *   3. tests/unit/*     (unit & regression tests)
 *
 * Usage:
 *   node tests/run.mjs               # run all suites
 *   node tests/run.mjs gates         # run gates only
 *   node tests/run.mjs contract      # run contract tests only
 *   node tests/run.mjs unit          # run unit tests only
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const filters = new Set(process.argv.slice(2).map((s) => s.toLowerCase()));
const runAll = filters.size === 0;

function collect(dir, suffix, exclude = new Set()) {
  const fullDir = path.join(here, dir);
  if (!fs.existsSync(fullDir)) return [];
  return fs.readdirSync(fullDir)
    .filter((name) => name.endsWith(suffix) && !exclude.has(name))
    .sort()
    .map((name) => ({ group: dir, name, file: path.join(fullDir, name) }));
}

const plan = [];
if (runAll || filters.has('gates')) {
  // release-visual-review-check.mjs runs in local pre-push on release tags (requires local screenshots)
  plan.push(...collect('gates', '.mjs', new Set(['release-visual-review-check.mjs'])));
}
if (runAll || filters.has('contract')) {
  plan.push(...collect('contract', '.test.mjs'));
}
if (runAll || filters.has('unit')) {
  plan.push(...collect('unit', '.test.mjs'));
}

if (plan.length === 0) {
  console.error('未匹配到任何测试文件，可用分组: gates / contract / unit');
  process.exit(1);
}

console.log(`\n================================================================`);
console.log(`  DeepSeek Harness Docker 测试与门禁套件（共 ${plan.length} 项）`);
console.log(`================================================================`);

const results = [];
const suiteStart = Date.now();

for (const item of plan) {
  const t0 = Date.now();
  const proc = spawnSync(process.execPath, [item.file], {
    cwd: root,
    env: { ...process.env, DSH_SKIP_PM_CONFIG_SYNC: '1' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const ms = Date.now() - t0;
  const passed = proc.status === 0;
  results.push({ ...item, passed, status: proc.status, ms, stdout: proc.stdout || '', stderr: proc.stderr || '' });
  const tag = passed ? 'PASS' : 'FAIL';
  const icon = passed ? '✔' : '❌';
  console.log(`  ${icon} [${tag}] ${item.group.padEnd(8)} ${item.name.padEnd(42)} ${String(ms).padStart(5)}ms`);
  if (!passed) {
    const tail = (proc.stdout + '\n' + proc.stderr).trim().split('\n').slice(-25).join('\n');
    console.log('     ┌─ 失败输出 ───────────────────────────────────────────');
    for (const line of tail.split('\n')) console.log('     │ ' + line);
    console.log('     └──────────────────────────────────────────────────────');
  }
}

const totalMs = Date.now() - suiteStart;
const failed = results.filter((r) => !r.passed);
const passed = results.length - failed.length;

console.log('\n================================================================');
console.log(`  汇总: ${passed} PASS / ${failed.length} FAIL / 共 ${results.length} 项 (耗时 ${(totalMs / 1000).toFixed(2)}s)`);
console.log('================================================================\n');

process.exit(failed.length === 0 ? 0 : 1);
