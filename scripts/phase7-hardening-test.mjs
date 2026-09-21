#!/usr/bin/env node
/**
 * 阶段 7 本地单测：工程化与打磨（M10–M13 + 轻微项）
 *  - 可运行部分：runTarAsync 超时/输出上限、atomicWrite、safeEqual(HMAC)、Cookie Secure、isSecureRequest；
 *  - 其余以源码级断言固化（Dockerfile / compose / workflow / gateway / entrypoint）。
 *
 * 用法: node scripts/phase7-hardening-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// ─────────────────────────────────────────────────────────────
console.log('\n[轻微项] 运行时可验证部分');
await check('runTarAsync：超时会被强制中断并报错', async () => {
  const backup = require(path.join(ROOT, 'gateway/backup-service.js'));
  assert.equal(typeof backup.runTarAsync, 'function', 'runTarAsync 应被导出以便测试');
  const t0 = Date.now();
  const err = await backup.runTarAsync(['-cf', '/dev/null', '--use-compress-program=sleep 30', '.'], { timeoutMs: 1200 })
    .then(() => null, e => e);
  assert.ok(err, '应当超时失败');
  assert.match(err.message, /超时/);
  assert.ok(Date.now() - t0 < 8000, '应被及时中断');
});

await check('runTarAsync：输出超过上限即中断（防恶意归档撑爆内存）', async () => {
  const backup = require(path.join(ROOT, 'gateway/backup-service.js'));
  // 造一个成员很多的目录，让 tar -t 输出超过 1KB
  const dir = path.join(tmp, 'many');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x');
  const tarFile = path.join(tmp, 'many.tar.gz');
  await backup.runTarAsync(['-czf', tarFile, '-C', dir, '.']);
  const err = await backup.runTarAsync(['-tvzf', tarFile], { maxOutputBytes: 1024 }).then(() => null, e => e);
  assert.ok(err, '应当因输出超限失败');
  assert.match(err.message, /输出超过上限/);
});

await check('_bootInternal 包装器：以实现函数显式 resolve 的值结算（不被提前 undefined 覆盖）', async () => {
  const mgr = require(path.join(ROOT, 'gateway/dsh-manager.js'));
  const orig = mgr._bootInternalImpl;
  try {
    mgr._bootInternalImpl = async (onProbe, resolve) => {
      // 模拟"函数体先返回、稍后才在嵌套回调里 resolve"
      setTimeout(() => resolve({ ok: true, marker: 'late-resolve' }), 40);
    };
    const r = await mgr._bootInternal();
    assert.equal(r && r.marker, 'late-resolve', '应等实现函数显式 resolve，而不是提前返回 undefined');
  } finally { mgr._bootInternalImpl = orig; }
});

await check('safeEqual 改为先 HMAC（长度不同也不再提前返回）', () => {
  const auth = require(path.join(ROOT, 'gateway/auth.js'));
  // 通过 verifyToken 间接验证行为仍然正确
  assert.equal(auth.verifyToken('phase7-token'), true);
  assert.equal(auth.verifyToken('phase7-toke'), false);
  assert.equal(auth.verifyToken('phase7-token-longer'), false);
  assert.equal(auth.verifyToken(''), false);
  const src = read('gateway/auth.js');
  assert.ok(/createHmac\('sha256', COMPARE_KEY\)/.test(src), 'safeEqual 应先 HMAC 再比较');
});

await check('Cookie Secure：仅 HTTPS 请求追加 Secure', () => {
  const auth = require(path.join(ROOT, 'gateway/auth.js'));
  assert.equal(auth.isSecureRequest({ socket: {}, headers: {} }), false);
  assert.equal(auth.isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
  assert.equal(auth.isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(auth.isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'http' } }), false);

  const grab = (req) => {
    const headers = {};
    auth.setAuthCookie({ setHeader: (k, v) => { headers[k] = v; } }, req);
    return headers['Set-Cookie'];
  };
  const plain = grab({ socket: {}, headers: {} });
  const secure = grab({ socket: {}, headers: { 'x-forwarded-proto': 'https' } });
  assert.ok(/HttpOnly/.test(plain) && /SameSite=Strict/.test(plain));
  assert.ok(!/; Secure/.test(plain), 'HTTP 下不应带 Secure');
  assert.ok(/; Secure/.test(secure), 'HTTPS 下应带 Secure');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M12] 构建上下文与插件依赖');
await check('.dockerignore 存在且排除关键目录', () => {
  const di = read('.dockerignore');
  for (const k of ['.git', '.env', 'data/', 'workspace/', '**/node_modules', 'doc/']) {
    assert.ok(di.includes(k), '.dockerignore 应包含 ' + k);
  }
});
await check('插件显式声明 schemastery 依赖', () => {
  const pkg = JSON.parse(read('plugins/dsh-browser-desktop/package.json'));
  assert.ok(pkg.dependencies && pkg.dependencies['@deepseek-ai/schemastery'], '应声明 @deepseek-ai/schemastery');
});
await check('Dockerfile 显式创建插件依赖软链（不再依赖构建残留）', () => {
  const df = read('Dockerfile');
  assert.ok(/node_modules\/@deepseek-ai/.test(df), 'Dockerfile 应为插件创建 @deepseek-ai 软链');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M10] 供应链');
await check('version.json 固定 dsh / pnpm / 市场插件版本', () => {
  const v = JSON.parse(read('version.json'));
  assert.ok(v.supply && v.supply.dshVersion && v.supply.pnpmVersion, 'supply 块应含 dshVersion/pnpmVersion');
  assert.ok(v.supply.marketPlugins && v.supply.marketPlugins.dshmarket);
});
await check('plugins.market.list：预装插件全部跟随 @latest', () => {
  const lines = read('plugins.market.list').split('\n')
    .map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(lines.length >= 2);
  // 全部有意写 @latest：每次构建拉最新（配合 Dockerfile MARKET_REFRESH 刷新预装层缓存）
  for (const l of lines) {
    assert.match(l, /@latest$/, '应写 @latest: ' + l);
  }
});
await check('Dockerfile：--ignore-scripts + 白名单 rebuild + integrity 校验', () => {
  const df = read('Dockerfile');
  assert.ok(/--ignore-scripts/.test(df), '应使用 --ignore-scripts');
  assert.ok(!/--ignore-scripts=false/.test(df), '不应再出现 --ignore-scripts=false');
  assert.ok(!/allow-scripts all/.test(df), '不应再全局放开 allow-scripts');
  assert.ok(/dist\.integrity/.test(df), '应校验 dist.integrity');
  assert.ok(/npm rebuild node-pty/.test(df), '白名单 rebuild');
});
await check('build.sh 从 version.json#supply 读取固定版本', () => {
  const bs = read('build.sh');
  assert.ok(/read_supply/.test(bs) && /PNPM_VERSION/.test(bs));
  assert.ok(!/DSH_ALPHA=\$\(curl/.test(bs), '不应再动态探测 registry 决定 DSH 版本');
});
await check('CI：action 固定 SHA + provenance/sbom + 冒烟测试', () => {
  const wf = read('.github/workflows/docker-build.yml');
  assert.ok(!/uses:\s+actions\/checkout@v4\b/.test(wf), 'action 应固定到 SHA');
  assert.ok(/actions\/checkout@[0-9a-f]{40}/.test(wf));
  assert.ok(/provenance:\s*mode=max/.test(wf));
  assert.ok(/sbom:\s*true/.test(wf));
  assert.ok(/smoke-test:/.test(wf) && /healthz/.test(wf));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M11] 容器加固');
await check('compose：no-new-privileges + cap_drop ALL + 最小 cap_add', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.market.yml']) {
    const c = read(f);
    assert.ok(/no-new-privileges:true/.test(c), f + ' 应含 no-new-privileges');
    assert.ok(/cap_drop:\s*\n\s*- ALL/.test(c), f + ' 应 cap_drop ALL');
    assert.ok(/cap_add:/.test(c), f + ' 应回补最小能力集');
    assert.ok(/user: "1001:1001"/.test(c), f + ' 应提供非 root 运行示例');
  }
});
await check('Dockerfile：非 root 用户 dsh(uid 1000) 且 /go 不再 777', () => {
  const df = read('Dockerfile');
  assert.ok(/useradd -m -u 1001/.test(df), '应创建 uid 1001 用户');
  assert.ok(/chmod -R 0755 \/go/.test(df), '/go 应为 0755');
  assert.ok(!/chmod -R 777/.test(df), '不应再有 777');
});
await check('网关/入口脚本支持 DSH_HOME 迁移（非 root 部署）', () => {
  for (const f of ['gateway/backup-service.js', 'gateway/dsh-manager.js', 'gateway/plugin-manager.js', 'gateway/internal-token.js']) {
    assert.ok(/DSH_HOME/.test(read(f)), f + ' 应支持 DSH_HOME');
  }
  const ep = read('scripts/entrypoint.sh');
  assert.ok(/DSH_HOME/.test(ep) && !/\/root\/\.dsh/.test(ep), 'entrypoint 不应再硬编码 /root/.dsh');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[M13] 配置单一来源');
await check('显式 env 优先于持久化配置，且 /healthz 回显来源', () => {
  const s = read('gateway/index.js');
  assert.ok(/const PROXY_PORT = Number\(process\.env\.PROXY_PORT \|\| persisted\.proxyPort\)/.test(s));
  assert.ok(/process\.env\.ADMIN_PATH \|\| persisted\.adminPath/.test(s));
  assert.ok(/AUTH_TOKEN_SOURCE/.test(s) && /configSource:/.test(s));
});
await check('分辨率默认值与 README/代码一致（1920x1080）', () => {
  assert.ok(!/DSH_DESKTOP_WIDTH=1440/.test(read('.env.example')));
  assert.ok(/DSH_DESKTOP_WIDTH=1920/.test(read('.env.example')));
  assert.ok(!/DSH_DESKTOP_WIDTH=1440/.test(read('docker-compose.yml')));
  assert.ok(/DSH_DESKTOP_WIDTH=1920/.test(read('docker-compose.market.yml')));
});
await check('compose 端口映射跟随 PROXY_PORT', () => {
  assert.ok(/\$\{PROXY_PORT:-3080\}:\$\{PROXY_PORT:-3080\}/.test(read('docker-compose.yml')));
  assert.ok(/PROXY_PORT=\$\{PROXY_PORT:-3080\}/.test(read('docker-compose.market.yml')));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[轻微项] 源码级回归');
await check('不再有 new Promise(async executor) 反模式', () => {
  for (const f of ['gateway/backup-service.js', 'gateway/dsh-manager.js']) {
    assert.ok(!/return new Promise\(async/.test(read(f)), f + ' 仍有反模式');
  }
});
await check('websockify 端点精确匹配', () => {
  const s = read('gateway/index.js');
  assert.ok(!/pathname\.endsWith\('\/websockify'\)/.test(s));
  assert.ok(/pathname === vncWsPath \|\| pathname === '\/websockify'/.test(s));
});
await check('pkill 不再使用过宽的 chromium 匹配', () => {
  const s = read('gateway/desktop-manager.js');
  const body = s.slice(s.indexOf('async forceCleanupSystemProcesses()'));
  const patterns = body.slice(0, body.indexOf('_pkill(pattern)'));
  assert.ok(!/^\s*'chromium'\s*,/m.test(patterns), '不应再把 chromium 作为 pkill 模式');
  assert.ok(/--user-data-dir=\$\{this\.config\.userDataDir\}/.test(patterns));
});
await check('日志不回显 Cookie 内容片段', () => {
  const s = read('gateway/token-crawler.js');
  assert.ok(!/cookiePair\.slice\(0, 25\)/.test(s));
  assert.ok(/len=\$\{cookiePair\.length\}/.test(s));
});
await check('version-service 不再静默吞异常', () => {
  const s = read('gateway/version-service.js');
  assert.ok(/读取本地 package\.json 版本失败/.test(s));
  assert.ok(/读取本地版本元数据失败/.test(s));
});
await check('install-plugin 使用原子写', () => {
  const s = read('scripts/install-plugin.mjs');
  assert.ok(/function atomicWrite/.test(s));
  assert.ok(!/fs\.writeFileSync\(/.test(s.replace(/function atomicWrite[\s\S]*?\n}\n/, '')), '除 helper 外不应再有裸 writeFileSync');
  // 回归守卫：helper 必须真的落盘，且不得递归调用自身（曾出现 atomicWrite(tmp,data) 自递归 → 栈溢出）
  const helper = /function atomicWrite[\s\S]*?\n}\n/.exec(s);
  assert.ok(helper, '应能定位 atomicWrite helper');
  assert.ok(/fs\.writeFileSync\(tmp/.test(helper[0]), 'atomicWrite 内必须调用 fs.writeFileSync(tmp, ...) 真正写盘');
  assert.ok(!/atomicWrite\(tmp/.test(helper[0]), 'atomicWrite 不得递归调用自身（会导致 Maximum call stack size exceeded）');
});
await check('DSH 日志落数据卷并轮转', () => {
  const s = read('scripts/entrypoint.sh');
  assert.ok(/DSH_WEB_LOG:-.*\.dsh\/logs\/dsh-web\.log/.test(s));
  assert.ok(/DSH_WEB_LOG_MAX_BYTES/.test(s) && /mv -f "\$\{DSH_WEB_LOG\}"/.test(s));
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
