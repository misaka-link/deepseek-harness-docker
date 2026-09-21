/**
 * 边界回归：关掉浏览器「最后一个标签页 / 最后一个窗口」后，能否"重新启动浏览器"。
 *
 * 场景：用户或 AI 把 Chromium 的页面标签页全部关掉（等价于在 VNC 里手动关掉最后一个窗口，
 *       Chromium 进程随之退出）。此时桌面应被判定为「不健康」，并能在下列入口自愈恢复：
 *         A) 用户打开 /vnc（后台「打开桌面」按钮 / 侧边栏 iframe 同源）
 *         B) AI 工具 browser_open（内部走 /__internal/desktop/start）
 *
 * 在容器内运行：node /app/scripts/edge-last-tab-recovery.mjs
 */
const GW = `http://127.0.0.1:${process.env.PROXY_PORT || 3080}`;
const CDP = `http://127.0.0.1:${process.env.DSH_CDP_PORT || 9222}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 内部接口共享密钥（M14）：网关启动时生成 0600 文件，容器内脚本读取后带上
import fs from 'node:fs';
const INTERNAL_TOKEN_FILE = process.env.DSH_INTERNAL_TOKEN_FILE || '/root/.dsh/.internal-api-token';
const internalHeaders = () => {
  try {
    const t = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim();
    if (t) return { 'x-dsh-internal-token': t };
  } catch {}
  return {};
};

async function pages() {
  try {
    const r = await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return (await r.json()).filter(t => t.type === 'page');
  } catch { return null; }
}
async function status() {
  try {
    const r = await fetch(`${GW}/__internal/desktop/status`, { headers: internalHeaders(), signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
}
async function closeAllTabs() {
  for (const p of (await pages()) || []) {
    try { await fetch(`${CDP}/json/close/${encodeURIComponent(p.id)}`); } catch {}
  }
}
// 轮询等待桌面恢复（最多 ~20s）
async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await status();
    if (s?.running === true && s?.healthy === true) return s;
    await sleep(1000);
  }
  return await status();
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

const mod = await import('/app/plugins/dsh-browser-desktop/index.js');
const tools = {};
mod.apply({
  tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
  systemPrompt: { section: () => () => {} },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
  on: () => {}
}, {});

console.log('\n=== 0. 确保桌面在运行 ===');
await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login' }, { signal: null });
let s = await waitHealthy(15000);
console.log('   初始: running=' + s?.running + ' healthy=' + s?.healthy);

console.log('\n=== A. 关掉最后一个标签页 → 打开 /vnc 应自愈 ===');
await closeAllTabs();
await sleep(3500);
let a1 = await status();
console.log('   关闭后: running=' + a1?.running + ' unhealthy=' + a1?.unhealthy);
ok(a1?.running === false && a1?.unhealthy === true, '桌面被正确判定为不健康（running=false / unhealthy=true）');
const r = await fetch(`${GW}/vnc/`, { headers: { Authorization: 'Bearer ' + (process.env.AUTH_TOKEN || '') }, redirect: 'manual' });
console.log('   GET /vnc/ -> HTTP ' + r.status);
let a2 = await waitHealthy(20000);
ok(a2?.running === true && a2?.healthy === true, '打开 /vnc 后浏览器自愈恢复');

console.log('\n=== B. 再次关掉最后一个标签页 → browser_open 应自愈 ===');
await closeAllTabs();
await sleep(3500);
let b1 = await status();
ok(b1?.running === false && b1?.unhealthy === true, '桌面再次被判为不健康');
let rec = null;
try { rec = await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login' }, { signal: null }); }
catch (e) { rec = { error: e.message }; }
console.log('   browser_open 返回:', JSON.stringify(rec).slice(0, 160));
ok(!!rec && !!rec.tabId, 'browser_open 重新拿回标签页 (tabId=' + (rec && rec.tabId) + ')');
let b2 = await waitHealthy(15000);
ok(b2?.running === true && b2?.healthy === true, '桌面恢复运行且健康');
const p2 = await pages();
ok(Array.isArray(p2) && p2.length >= 1, 'CDP 又有可用页面 (' + (p2 ? p2.length : 'n/a') + ')');

console.log(`\n===== 边界回归汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
