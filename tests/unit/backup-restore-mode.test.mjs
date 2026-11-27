#!/usr/bin/env node
/**
 * 快照创建、恢复范围可选 (config-only / full)、keep-live (.internal-api-token) 与 plugins-state 防复活回归测试。
 * 用法: node tests/unit/backup-restore-mode.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-mode-test-'));
const TEST_DSH_HOME = path.join(TEST_ROOT, 'mock_home');
const TEST_SNAPSHOTS_DIR = path.join(TEST_ROOT, 'mock_snapshots');
const TEST_DSH_DIR = path.join(TEST_DSH_HOME, '.dsh');

fs.mkdirSync(TEST_DSH_DIR, { recursive: true });
fs.mkdirSync(TEST_SNAPSHOTS_DIR, { recursive: true });

process.env.DSH_HOME = TEST_DSH_HOME;
process.env.DSH_DIR = TEST_DSH_DIR;
process.env.DSH_SNAPSHOTS_DIR = TEST_SNAPSHOTS_DIR;
process.env.DSH_PORT = '39999';

const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (cmd, args) {
  if (cmd === 'ps' && Array.isArray(args) && args.includes('-eo')) {
    return { status: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'fuser') {
    return { status: 0, stdout: '', stderr: '' };
  }
  return origSpawnSync.apply(this, arguments);
};

const manifestModule = require(path.join(root, 'gateway/src/backup/snapshot-manifest.js'));
const backupService = require(path.join(root, 'gateway/src/backup/index.js'));

let passCount = 0;
let failCount = 0;
const pass = (id, msg) => { console.log(`   ✔ [PASS] ${id}: ${msg}`); passCount++; };
const fail = (id, msg, detail = '') => {
  console.error(`   ❌ [FAIL] ${id}: ${msg}`);
  if (detail) console.error(`      详情: ${detail}`);
  failCount++;
};

function buildSnapshotArchive(filename, filesMap) {
  const stageDir = fs.mkdtempSync(path.join(TEST_ROOT, 'stage-build-'));
  const dshSub = path.join(stageDir, '.dsh');
  fs.mkdirSync(dshSub, { recursive: true });

  for (const [relPath, content] of Object.entries(filesMap)) {
    const full = path.join(dshSub, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const archivePath = path.join(TEST_SNAPSHOTS_DIR, filename);
  const tarRes = origSpawnSync('tar', ['-czf', archivePath, '-C', stageDir, '.dsh'], { encoding: 'utf8' });
  if (tarRes.status !== 0) throw new Error(`打包测试快照失败: ${tarRes.stderr}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  return archivePath;
}

function cleanLiveDsh() {
  fs.rmSync(TEST_DSH_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DSH_DIR, { recursive: true });
}

const mockDsh = { stop: async () => true, boot: async () => ({ ok: true }) };

async function runAll() {
  try {
    // TC-06: 默认 full 模式 + keep-live (.internal-api-token / gateway.config.json / .session_secret)
    cleanLiveDsh();
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/s_live_1'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'sessions/s_live_1/content.json'), '{"live":true}');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'server: live_value');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'gateway.config.json'), '{"authToken":"live_token"}');
    fs.writeFileSync(path.join(TEST_DSH_DIR, '.session_secret'), 'live-session-secret-0123456789abcdef');
    fs.writeFileSync(path.join(TEST_DSH_DIR, '.internal-api-token'), 'live-internal-token-keep-me');

    const snap06 = 'dsh-manual-2026-09-30-tc06.tar.gz';
    buildSnapshotArchive(snap06, {
      'cordis.patch.yml': 'server: snapshot_value',
      'sessions/s_snap_1/content.json': '{"snap":true}',
      '.internal-api-token': 'stale-token-from-snapshot'
    });
    const res06 = await backupService.restoreBackup(snap06, mockDsh);
    const tok06 = fs.readFileSync(path.join(TEST_DSH_DIR, '.internal-api-token'), 'utf8');
    if (
      res06.ok &&
      fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8').includes('snapshot_value') &&
      fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/s_snap_1')) &&
      !fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/s_live_1')) &&
      fs.existsSync(path.join(TEST_DSH_DIR, 'gateway.config.json')) &&
      tok06 === 'live-internal-token-keep-me'
    ) {
      pass('TC-06', '默认 full 还原替换会话并穿透保留 gateway.config.json / .session_secret / .internal-api-token');
    } else {
      fail('TC-06', '默认 full 还原状态不符', JSON.stringify({ res06, tok06 }));
    }

    // TC-03: 命名欺诈防御
    const inferred = manifestModule.inferFromMembers([
      '.dsh/cordis.patch.yml',
      '.dsh/profiles/web/package.json',
      '.dsh/sessions/session_uuid/meta.json',
      '.dsh/attachments/doc.pdf'
    ], 'dsh-config-2026-09-30-fake.tar.gz');
    if (inferred && inferred.backupType === 'full') {
      pass('TC-03', '含会话归档改名为 config 仍基于内容判定为 full');
    } else {
      fail('TC-03', '命名欺诈未被识别', JSON.stringify(inferred));
    }

    // TC-01: config-only 保留现网会话
    cleanLiveDsh();
    for (const s of ['S1', 'S2', 'S3']) {
      fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions', s), { recursive: true });
      fs.writeFileSync(path.join(TEST_DSH_DIR, 'sessions', s, 'meta.json'), `{"id":"${s}"}`);
    }
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'theme: live_dark');
    const snap01 = 'dsh-full-2026-09-30-tc01.tar.gz';
    buildSnapshotArchive(snap01, {
      'cordis.patch.yml': 'theme: snapshot_light',
      'sessions/B1/meta.json': '{"id":"B1"}'
    });
    const res01 = await backupService.restoreBackup(snap01, mockDsh, { mode: 'config-only' });
    if (
      res01.ok && res01.mode === 'config-only' &&
      fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8').includes('snapshot_light') &&
      fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json')) &&
      fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S3/meta.json')) &&
      !fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/B1'))
    ) {
      pass('TC-01', 'config-only 还原保留现网 S1~S3，排除快照 B1');
    } else {
      fail('TC-01', 'config-only 状态异常');
    }

    // TC-02: 故障注入回滚
    cleanLiveDsh();
    fs.mkdirSync(path.join(TEST_DSH_DIR, 'sessions/S1'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json'), '{"id":"S1"}');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'server: original_live');
    const snap02 = 'dsh-faulty-2026-09-30-tc02.tar.gz';
    buildSnapshotArchive(snap02, { 'cordis.patch.yml': 'server: broken_staging' });
    let thrown02 = false;
    try {
      await backupService.restoreBackup(snap02, {
        stop: async () => true,
        boot: async () => { throw new Error('Simulated boot failure'); }
      }, { mode: 'config-only' });
    } catch { thrown02 = true; }
    if (thrown02 && fs.existsSync(path.join(TEST_DSH_DIR, 'sessions/S1/meta.json')) &&
        fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8').includes('original_live')) {
      pass('TC-02', '启动失败精确逆向回滚并原地保留现网会话');
    } else {
      fail('TC-02', '故障注入回滚失败');
    }

    // TC-04: 空环境 config-only
    cleanLiveDsh();
    const snap04 = 'dsh-clean-2026-09-30-tc04.tar.gz';
    buildSnapshotArchive(snap04, {
      'cordis.patch.yml': 'mode: empty_env_test',
      'storages/workspace.json': '{"sessionIds":["ghost1"]}'
    });
    const res04 = await backupService.restoreBackup(snap04, mockDsh, { mode: 'config-only' });
    const wsPath04 = path.join(TEST_DSH_DIR, 'storages/workspace.json');
    const wsRaw04 = fs.existsSync(wsPath04) ? fs.readFileSync(wsPath04, 'utf8') : '';
    if (res04.ok && fs.readFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'utf8').includes('empty_env_test') &&
        !wsRaw04.includes('ghost1')) {
      pass('TC-04', '空环境 config-only 排除快照 storages/workspace.json 孤儿索引并干净初始化');
    } else {
      fail('TC-04', '空环境 config-only 状态异常', wsRaw04);
    }

    // TC-05: 离线保留现网 node_modules（不触发联网 pnpm install）
    cleanLiveDsh();
    const liveMod = path.join(TEST_DSH_DIR, 'profiles/web/node_modules/cached_pkg');
    fs.mkdirSync(liveMod, { recursive: true });
    fs.writeFileSync(path.join(liveMod, 'index.js'), 'module.exports = "cached";');
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'server: live');
    const snap05 = 'dsh-offline-2026-09-30-tc05.tar.gz';
    buildSnapshotArchive(snap05, {
      'cordis.patch.yml': 'server: offline_snap',
      'profiles/web/package.json': '{"name":"web","dependencies":{"cached_pkg":"1.0.0"}}'
    });
    const res05 = await backupService.restoreBackup(snap05, mockDsh, { mode: 'config-only' });
    if (res05.ok && fs.existsSync(path.join(TEST_DSH_DIR, 'profiles/web/node_modules/cached_pkg/index.js'))) {
      pass('TC-05', '离线 config-only 保留现网 node_modules，未触发联网重装');
    } else {
      fail('TC-05', '离线 config-only 失败');
    }

    // TC-07 (v1.0.0): plugins-state.json 合并策略（防卸载/停用插件复活）
    cleanLiveDsh();
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'plugins-state.json'), JSON.stringify({
      disabled: ['live-disabled'],
      uninstalled: ['live-uninstalled'],
      known: ['live-disabled', 'live-uninstalled']
    }));
    const snap07a = 'dsh-nostate-2026-09-30-tc07a.tar.gz';
    buildSnapshotArchive(snap07a, { 'cordis.patch.yml': 'server: nostate' });
    await backupService.restoreBackup(snap07a, mockDsh);
    const st07a = JSON.parse(fs.readFileSync(path.join(TEST_DSH_DIR, 'plugins-state.json'), 'utf8'));
    if (st07a.uninstalled.includes('live-uninstalled') && st07a.known.includes('live-disabled')) {
      pass('TC-07a', '快照不含 plugins-state.json 时保留现网插件状态');
    } else {
      fail('TC-07a', '现网 plugins-state.json 被丢失', JSON.stringify(st07a));
    }

    const snap07b = 'dsh-withstate-2026-09-30-tc07b.tar.gz';
    buildSnapshotArchive(snap07b, {
      'cordis.patch.yml': 'server: withstate',
      'plugins-state.json': JSON.stringify({ disabled: ['snap-disabled'], uninstalled: [], known: ['snap-disabled'] })
    });
    await backupService.restoreBackup(snap07b, mockDsh);
    const st07b = JSON.parse(fs.readFileSync(path.join(TEST_DSH_DIR, 'plugins-state.json'), 'utf8'));
    if (st07b.known.includes('live-uninstalled') && st07b.known.includes('snap-disabled')) {
      pass('TC-07b', '快照含 plugins-state.json 时合并 known = live.known ∪ snap.known 防复活');
    } else {
      fail('TC-07b', 'plugins-state.json known 合并失败', JSON.stringify(st07b));
    }

    // TC-08 (v1.0.0): 自定义非 /root 的 DSH_HOME 创建快照打包真实目录、0600 权限且排除内部目录
    cleanLiveDsh();
    fs.writeFileSync(path.join(TEST_DSH_DIR, 'cordis.patch.yml'), 'theme: custom_home\n');
    fs.mkdirSync(path.join(TEST_DSH_DIR, '.dsh-meta'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DSH_DIR, '.dsh-meta', 'junk.txt'), 'skip');
    const created = await backupService.createBackup('custom-home', 'full');
    const snapPath = path.join(TEST_SNAPSHOTS_DIR, created.snapshot.filename);
    const mode = fs.statSync(snapPath).mode & 0o777;
    const listOut = origSpawnSync('tar', ['-tzf', snapPath], { encoding: 'utf8' }).stdout || '';
    if (created.ok && mode === 0o600 && listOut.includes('.dsh/cordis.patch.yml') && !listOut.includes('.dsh-meta')) {
      pass('TC-08', '非 /root DSH_HOME 创建快照正确打包实际目录、权限 0600 且排除 .dsh-meta');
    } else {
      fail('TC-08', '自定义 DSH_HOME 创建快照异常', JSON.stringify({ mode: mode.toString(8), listOut }));
    }
  } finally {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }

  console.log(`\n===== 汇总: 通过 ${passCount} / 失败 ${failCount} =====`);
  process.exit(failCount > 0 ? 1 : 0);
}

runAll().catch((err) => { console.error('测试异常:', err); process.exit(1); });
