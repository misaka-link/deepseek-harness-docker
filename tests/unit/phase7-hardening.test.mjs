#!/usr/bin/env node
/**
 * 工程化与容器安全加固单元测试（运行期 + 静态契约）。
 * 用法: node tests/unit/phase7-hardening.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p7-'));
process.env.DSH_DIR = tmp;
process.env.SESSION_SECRET = 'phase7-test-secret-0123456789';
process.env.AUTH_TOKEN = 'phase7-token';

try {
  console.log('\n[1] 运行时加固验证');
  const backup = require(path.join(ROOT, 'gateway/src/backup/index.js'));
  await check('runTarAsync：超时会被强制中断并报错', async () => {
    const t0 = Date.now();
    const err = await backup.runTarAsync(['-cf', '/dev/null', '--use-compress-program=sleep 30', '.'], { timeoutMs: 1200 })
      .then(() => null, (e) => e);
    assert.ok(err && /超时/.test(err.message) && Date.now() - t0 < 8000);
  });

  await check('runTarAsync：输出超过上限即中断', async () => {
    const dir = path.join(tmp, 'many');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x');
    const tarFile = path.join(tmp, 'many.tar.gz');
    await backup.runTarAsync(['-czf', tarFile, '-C', dir, '.']);
    const err = await backup.runTarAsync(['-tvzf', tarFile], { maxOutputBytes: 1024 }).then(() => null, (e) => e);
    assert.ok(err && /输出超过上限/.test(err.message));
  });

  await check('safeEqual 使用 HMAC 常量时间比较且仅 HTTPS 下 Cookie 追加 Secure', () => {
    const session = require(path.join(ROOT, 'gateway/src/auth/session.js'));
    assert.equal(session.verifyToken('phase7-token'), true);
    assert.equal(session.verifyToken('phase7-toke'), false);
    assert.equal(session.verifyToken('phase7-token-longer'), false);
    assert.equal(session.verifyToken(''), false);
    assert.ok(/createHmac\('sha256', COMPARE_KEY\)/.test(read('gateway/src/auth/session.js')));

    assert.equal(session.isSecureRequest({ socket: {}, headers: {} }), false);
    assert.equal(session.isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
    assert.equal(session.isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }), true);
    const grab = (req) => { const h = {}; session.setAuthCookie({ setHeader: (k, v) => { h[k] = v; } }, req); return h['Set-Cookie']; };
    assert.ok(!/; Secure/.test(grab({ socket: {}, headers: {} })));
    assert.ok(/; Secure/.test(grab({ socket: {}, headers: { 'x-forwarded-proto': 'https' } })));
  });

  console.log('\n[2] 构建上下文、供应链与容器安全静态契约');
  await check('.dockerignore 排除关键目录', () => {
    const di = read('.dockerignore');
    for (const k of ['.git', '.env', 'data/', 'workspace/', '**/node_modules', 'doc/']) {
      assert.ok(di.includes(k), '.dockerignore 应包含 ' + k);
    }
  });

  await check('插件显式声明 schemastery 依赖且 Dockerfile 建软链', () => {
    const pkg = JSON.parse(read('plugins/dsh-browser-desktop/package.json'));
    assert.ok(pkg.dependencies && pkg.dependencies['@deepseek-ai/schemastery']);
    assert.ok(/node_modules\/@deepseek-ai/.test(read('Dockerfile')));
  });

  await check('version.json 固定供应链版本 + plugins.market.list 跟随 @latest', () => {
    const v = JSON.parse(read('version.json'));
    assert.ok(v.supply?.dshVersion && v.supply?.pnpmVersion && v.supply?.marketPlugins?.dshmarket);
    const lines = read('plugins.market.list').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    assert.ok(lines.length >= 2 && lines.every((l) => /@latest$/.test(l)));
  });

  await check('Dockerfile：--ignore-scripts、integrity 校验、uid 1001、构建期补丁+扫描、HEALTHCHECK 跟随 PROXY_PORT', () => {
    const df = read('Dockerfile');
    assert.ok(/--ignore-scripts/.test(df) && !/--ignore-scripts=false/.test(df));
    assert.ok(/dist\.integrity/.test(df) && /npm rebuild node-pty/.test(df));
    assert.ok(/useradd -m -u 1001/.test(df) && /chmod -R 0755 \/go/.test(df) && !/chmod -R 777/.test(df));
    assert.ok(/patch-dsh-client\.mjs --build/.test(df) && /needle-scan\.mjs --build/.test(df));
    assert.ok(/PROXY_PORT:-3080\}\/healthz/.test(df));
  });

  await check('build.sh 从 version.json#supply 读取固定版本', () => {
    const bs = read('build.sh');
    assert.ok(/read_supply/.test(bs) && /PNPM_VERSION/.test(bs) && !/DSH_ALPHA=\$\(curl/.test(bs));
  });

  await check('CI：action 固定 SHA + 冒烟测试 + 回归门禁', () => {
    const wf = read('.github/workflows/docker-build.yml');
    assert.ok(!/uses:\s+actions\/checkout@v4\b/.test(wf) && /actions\/checkout@[0-9a-f]{40}/.test(wf));
    assert.ok(/smoke-test:/.test(wf) && /healthz/.test(wf));
  });

  await check('compose 加固与端口/分辨率一致性', () => {
    for (const f of ['docker-compose.yml', 'docker-compose.market.yml', 'docker-compose.full.yml']) {
      const c = read(f);
      assert.ok(/no-new-privileges:true/.test(c) && /cap_drop:\s*\n\s*- ALL/.test(c) && /cap_add:/.test(c));
      assert.ok(/user: "1001:1001"/.test(c) && /DSH_DESKTOP_WIDTH=1920/.test(c));
      assert.ok(/\$\{PROXY_PORT:-3080\}:\$\{PROXY_PORT:-3080\}/.test(c));
    }
    assert.ok(/DSH_DESKTOP_WIDTH=1920/.test(read('.env.example')) && !/DSH_DESKTOP_WIDTH=1440/.test(read('.env.example')));
  });

  await check('capabilities 4-tier 变体与 DSH_INSTALL_GO / DSH_CAPABILITIES 优先级', () => {
    const { computeCapabilities } = require(path.join(ROOT, 'gateway/src/core/capabilities.js'));
    const std = computeCapabilities({ DSH_VARIANT: 'standard', DSH_INSTALL_GO: '0' });
    assert.equal(std.variant, 'standard');
    assert.equal(std.desktop.supported, true);
    assert.equal(std.golang.supported, false);

    const mkt = computeCapabilities({ DSH_VARIANT: 'market', DSH_INSTALL_GO: '0' });
    assert.equal(mkt.variant, 'market');
    assert.equal(mkt.desktop.supported, true);
    assert.equal(mkt.golang.supported, false);

    const full = computeCapabilities({ DSH_VARIANT: 'full', DSH_INSTALL_GO: '1' });
    assert.equal(full.variant, 'full');
    assert.equal(full.desktop.supported, true);
    assert.equal(full.golang.supported, true);

    const fullLegacy = computeCapabilities({ DSH_VARIANT: 'full' });
    assert.equal(fullLegacy.golang.supported, true);

    const mini = computeCapabilities({ DSH_VARIANT: 'mini', DSH_INSTALL_GO: '0' });
    assert.equal(mini.variant, 'mini');
    assert.equal(mini.desktop.supported, false);
    assert.equal(mini.golang.supported, false);

    const goOverride = computeCapabilities({ DSH_VARIANT: 'standard', DSH_INSTALL_GO: '1' });
    assert.equal(goOverride.golang.supported, true);

    const capOverride = computeCapabilities({ DSH_VARIANT: 'full', DSH_INSTALL_GO: '1', DSH_CAPABILITIES: 'golang=0' });
    assert.equal(capOverride.golang.supported, false);
  });

  await check('entrypoint.sh 支持 DSH_HOME / PUID-PGID / Preflight / 日志轮转 / 补丁 --verify', () => {
    const ep = read('scripts/entrypoint.sh');
    assert.ok(/DSH_HOME/.test(ep) && /DSH_DIR/.test(ep));
    assert.ok(/PUID/.test(ep) && /PGID/.test(ep) && /setpriv/.test(ep));
    assert.ok(/Preflight/.test(ep) && /DSH_WEB_LOG_MAX_BYTES/.test(ep));
    assert.ok(/patch-dsh-client\.mjs --verify/.test(ep));
  });

  await check('网关模块无反模式：精确 websockify、精确 pkill、无 Cookie 明文日志、无 new Promise(async)', () => {
    const wsUp = read('gateway/src/proxy/ws-upgrade.js');
    assert.ok(!/pathname\.endsWith\('\/websockify'\)/.test(wsUp));
    const dmSrc = read('gateway/src/desktop/desktop-manager.js');
    assert.ok(/--user-data-dir=\$\{this\.config\.userDataDir\}/.test(dmSrc));
    const supSrc = read('gateway/src/dsh/supervisor.js');
    assert.ok(!/cookiePair\.slice\(0, 25\)/.test(supSrc) && /redactLog/.test(supSrc));
    for (const f of ['gateway/src/backup/restore.js', 'gateway/src/dsh/supervisor.js', 'gateway/src/dsh/installer.js']) {
      assert.ok(!/return new Promise\(async/.test(read(f)), f + ' 不应含 new Promise(async)');
    }
  });

  await check('install-plugin 使用原子写且无自递归', () => {
    const s = read('scripts/install-plugin.mjs');
    const helper = /function atomicWrite[\s\S]*?\n}\n/.exec(s);
    assert.ok(helper && /fs\.writeFileSync\(tmp/.test(helper[0]) && !/atomicWrite\(tmp/.test(helper[0]));
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
