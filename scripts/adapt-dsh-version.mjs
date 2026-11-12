#!/usr/bin/env node
/**
 * 适配 DSH 上游版本：从 npm 读取 dist.integrity，更新 version.json / Dockerfile / build.sh。
 * 用法：
 *   node scripts/adapt-dsh-version.mjs --version 0.2.2-rc.2 --dry-run
 *   node scripts/adapt-dsh-version.mjs --version 0.2.2-rc.2 --write
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  return fallback;
}
const version = arg('version', '');
const write = argv.includes('--write');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('用法: node scripts/adapt-dsh-version.mjs --version <x.y.z[-tag]> [--write]');
  process.exit(2);
}

async function fetchIntegrity(v) {
  const regs = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];
  const errors = [];
  for (const reg of regs) {
    try {
      const res = await fetch(reg + '/@deepseek-ai%2Fdsh', { headers: { accept: 'application/json' } });
      if (!res.ok) { errors.push(reg + ': HTTP ' + res.status); continue; }
      const data = await res.json();
      const pkg = data.versions && data.versions[v];
      if (pkg && pkg.dist && pkg.dist.integrity) {
        return { integrity: pkg.dist.integrity, tarball: pkg.dist.tarball, registry: reg };
      }
      errors.push(reg + ': 无版本 ' + v);
    } catch (e) {
      errors.push(reg + ': ' + e.message);
    }
  }
  throw new Error('npm 未发布 @deepseek-ai/dsh@' + v + '（' + errors.join('；') + '）');
}

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function writeFile(rel, content) { fs.writeFileSync(path.join(root, rel), content); }

function updateVersionJson(text, v, integrity) {
  const data = JSON.parse(text);
  data.supply = data.supply || {};
  data.supply.dshVersion = v;
  data.supply.dshIntegrity = integrity;
  data.supply.note = '供应链版本：build.sh 读取本块作为默认构建参数；可用环境变量 PNPM_VERSION / DSH_VERSION 覆盖。市场预装插件配置为 latest，每次构建拉取最新社区版本。dshVersion ' + v + ' 来源 npm dist-tag next。';
  return JSON.stringify(data, null, 2) + '\n';
}
function updateDockerfile(text, v, integrity) {
  return text
    .replace(/ARG DSH_VERSION="[^"]*"/, 'ARG DSH_VERSION="' + v + '"')
    .replace(/ARG DSH_INTEGRITY="[^"]*"/, 'ARG DSH_INTEGRITY="' + integrity + '"');
}
function updateBuildSh(text, v) {
  return text.replace(/PINNED_DSH:-[0-9A-Za-z.-]+/, 'PINNED_DSH:-' + v);
}

const vj = read('version.json');
const df = read('Dockerfile');
const bs = read('build.sh');

let info;
try {
  info = await fetchIntegrity(version);
} catch (e) {
  console.error('[adapt-dsh-version] 阻塞: ' + e.message);
  console.error('[adapt-dsh-version] 未修改任何文件。请等待上游执行 release-publish 后再试。');
  process.exit(1);
}

const next = [
  ['version.json', updateVersionJson(vj, version, info.integrity)],
  ['Dockerfile', updateDockerfile(df, version, info.integrity)],
  ['build.sh', updateBuildSh(bs, version)],
];
console.log('[adapt-dsh-version] npm 来源: ' + info.registry);
console.log('[adapt-dsh-version] integrity: ' + info.integrity);
for (const [rel, content] of next) {
  const before = read(rel);
  const changed = before !== content;
  console.log('[adapt-dsh-version] ' + rel + ': ' + (changed ? '将更新' : '无变化'));
  if (changed && write) writeFile(rel, content);
}
if (!write) {
  console.log('[adapt-dsh-version] dry-run：未写入。加 --write 应用。');
} else {
  console.log('[adapt-dsh-version] 已写入。下一步: 运行 patch/test/远程构建验证。');
}
