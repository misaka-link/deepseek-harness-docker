/**
 * S4 回归测试：patch-dsh-client.mjs 的"必需补丁未命中即失败"行为。
 * 用法: node scripts/patch-required-test.mjs
 *
 * 在沙箱目录里伪造一份最小 DSH 目录结构，验证：
 *   A. 锚点齐全 → 退出码 0，且标记全部命中
 *   B. 破坏 auth 锚点 → 退出码非 0，且打印 [FATAL]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/patch-dsh-client.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

/** 用 node --check 验证文件语法（补丁把代码插进方法体，语法坏掉等于整包加载失败） */
const syntaxOkFile = (file) => spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status === 0;

const LOOPBACK_SNIPPET = 'const x = isLoopbackHostname(pageLocation.hostname);';
// 0.2.1-alpha.1 及更早签名
const AUTH_SNIPPET = 'class C {\n\tisAuthenticated(request) {\n\t\treturn false;\n\t}\n}\n';
// 0.2.1-alpha.2 起签名：新增 secure 参数（锚点必须兼容新旧两种形态）
const AUTH_SNIPPET_NEW = 'class C {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n';
const COMBO_SNIPPET = 'class R {\n\tbundleResource(method, url) {\n\t\tconst resourceUrl = url;\n\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);\n\t\treturn response;\n\t\treturn { status: 404 };\n\t}\n\tserveBundle = async (req, res) => {\n\t};\n}\n';

// 0.2.3-alpha.1 起：BrowserAuth 迁到独立包 dsh-host-authentication-token，
// dsh-client-connection 里已不再有 isAuthenticated 定义（旧锚点文件不存在）。
const AUTH_CARRIER_NEW = 'dsh-host-authentication-token/lib/index.js';
const AUTH_CARRIER_OLD = 'dsh-client-connection/lib/index.js';
// 0.2.3 新增包，内含同名 isAuthenticated（签名无默认值），绝不能被本补丁改动
const REMOTE_CONN_FILE = 'dsh-client-remote-connection/lib/index.js';
const REMOTE_CONN_SNIPPET = 'class RC {\n\tisAuthenticated(request, secure) {\n\t\treturn false;\n\t}\n}\n';

function makeSandbox(name, {
  breakAuth = false,
  authSnippet = AUTH_SNIPPET,
  dshVersion = '0.2.1-alpha.2',
  clientFile = 'dsh-client-ui-layout/lib/client.js',
  // 'old' = 锚点在 dsh-client-connection（≤0.2.2）；'new' = 在 dsh-host-authentication-token（≥0.2.3-alpha.1）
  authCarrier = 'old',
  // 新代运行时旧载体里的内容（用于「新旧载体都带同名方法」这类对抗用例）
  oldCarrierBody = null,
  // dsh-client-remote-connection/lib/index.js 的内容（不该被本补丁改动）
  remoteConn = null,
} = {}) {
  const base = path.join(os.tmpdir(), `dsh-patch-${name}-${Date.now()}`);
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }));
  write(clientFile, LOOPBACK_SNIPPET + '\n');
  write('dsh-client-modules/lib/index.js', COMBO_SNIPPET);

  const carrierBody = breakAuth ? 'class C {\n\tother() {}\n}\n' : authSnippet;
  if (authCarrier === 'new') {
    write(AUTH_CARRIER_NEW, carrierBody);
    // 旧载体在 0.2.3 依然存在（它是十几个 dsh-api-* / dsh-client-* 的直接依赖），
    // 只是不再定义 isAuthenticated —— 默认按这个真实形态造夹具。
    write(AUTH_CARRIER_OLD, oldCarrierBody ?? 'class C {\n\tother() {}\n}\n');
  } else {
    write(AUTH_CARRIER_OLD, carrierBody);
  }
  // 0.2.3 新增的 dsh-client-remote-connection 里也有同名方法（Remote 登录的独立签名校验）
  if (remoteConn) write(REMOTE_CONN_FILE, remoteConn);
  return base;
}

function runPatch(base) {
  return spawnSync('node', [SCRIPT], {
    env: {
      ...process.env,
      // 只扫描沙箱目录，避免环境里其它（可能已打过补丁的）DSH 副本干扰判定
      DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai')
    },
    encoding: 'utf8'
  });
}

console.log('\n=== A. 锚点齐全 → 应成功 ===');
const good = makeSandbox('good');
const rA = runPatch(good);
ok(rA.status === 0, `退出码为 0（实际 ${rA.status}）`);
ok(/全部必需补丁已生效/.test(rA.stdout || ''), '输出包含"全部必需补丁已生效"');
ok(/已应用=\[[^\]]*auth-bypass/.test(rA.stdout || ''), 'auth-bypass 被标记为已应用');
ok(/已应用=\[[^\]]*combo-fallback/.test(rA.stdout || ''), 'combo-fallback 被标记为已应用');
ok(/已应用=\[[^\]]*client-loopback/.test(rA.stdout || ''), 'client-loopback 被标记为已应用');

console.log('\n=== B. 破坏 auth 锚点 → 应 FATAL 非零退出 ===');
const bad = makeSandbox('bad', { breakAuth: true });
const rB = runPatch(bad);
const rBOut = (rB.stdout || '') + (rB.stderr || '');
ok(rB.status !== 0, `退出码非 0（实际 ${rB.status}）`);
ok(/\[FATAL\]/.test(rBOut), '输出包含 [FATAL]');
ok(/auth-bypass/.test(rBOut), '指出未命中的补丁名 auth-bypass');

console.log('\n=== C. 0.2.1-alpha.2 新签名 isAuthenticated(request, secure = false) → 应成功 ===');
const newer = makeSandbox('newer', { authSnippet: AUTH_SNIPPET_NEW });
const rC = runPatch(newer);
ok(rC.status === 0, `退出码为 0（实际 ${rC.status}）`);
ok(/全部必需补丁已生效/.test(rC.stdout || ''), '输出包含"全部必需补丁已生效"');
ok(/已应用=\[[^\]]*auth-bypass/.test(rC.stdout || ''), 'auth-bypass 被标记为已应用（新签名命中）');

console.log('\n=== D. 版本横幅跟随被扫描的树（R4：不得读环境里其它 DSH） ===');
const vtree = makeSandbox('vtree', { dshVersion: '9.9.9-probe' });
const rD = runPatch(vtree);
const rDOut = (rD.stdout || '') + (rD.stderr || '');
ok(rD.status === 0, `退出码为 0（实际 ${rD.status}）`);
ok(/DSH 版本: 9\.9\.9-probe/.test(rDOut), '横幅显示被扫描树的版本 9.9.9-probe（而非 /usr/local 的旧版本）');
ok(/来源: .*vtree/.test(rDOut), '横幅标注版本来源为沙箱树');
ok(/全部必需补丁已生效/.test(rDOut), '必需补丁仍全部命中');

console.log('\n=== E. 0.2.1-alpha.3 客户端文件拆分 client.browser.js → 应成功 ===');
const a3browser = makeSandbox('a3browser', { clientFile: 'dsh-client-connection/lib/client.browser.js', dshVersion: '0.2.1-alpha.3' });
const rE = runPatch(a3browser);
ok(rE.status === 0, `退出码为 0（实际 ${rE.status}）`);
ok(/已应用=\[[^\]]*client-loopback/.test(rE.stdout || ''), 'client-loopback 在 client.browser.js 上命中');
ok(/全部必需补丁已生效/.test(rE.stdout || ''), '输出包含"全部必需补丁已生效"');

console.log('\n=== G. 0.2.3-alpha.2 真实形态（新载体 + 新签名，旧载体已无该方法）→ 应成功 ===');
const moved = makeSandbox('moved', { authCarrier: 'new', authSnippet: AUTH_SNIPPET_NEW, dshVersion: '0.2.3-alpha.2' });
const rG = runPatch(moved);
const rGOut = (rG.stdout || '') + (rG.stderr || '');
ok(rG.status === 0, `退出码为 0（实际 ${rG.status}）`);
ok(/已应用=\[[^\]]*auth-bypass/.test(rGOut), 'auth-bypass 在新载体上被标记为已应用');
ok(/dsh-host-authentication-token/.test(rGOut), '输出指出实际打补丁的文件为新载体');
ok(/全部必需补丁已生效/.test(rGOut), '输出包含"全部必需补丁已生效"');
const newCarrierAfter = fs.readFileSync(path.join(moved, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8');
ok((newCarrierAfter.match(/auth-bypass-all/g) || []).length === 1, '新载体只注入一处标记（不重复）');
// 关键：必须验证 return true 真的落在方法体第一句 —— 只数 marker 的话，
// 「只追加 marker、根本不注入 return true」的坏实现也能全绿（对抗验证已复现）。
ok(/isAuthenticated\([^)]*\)\s*\{\s*\n\s*\/\* dsh-patch: auth-bypass-all \*\/ return true;/.test(newCarrierAfter),
  'return true 位于 isAuthenticated 方法体第一句');
ok(/dsh-patch: auth-bypass-all \*\/ return true;[\s\S]*return false;/.test(newCarrierAfter),
  '原方法体（return false）保留在注入点之后，未被替换掉');
ok(syntaxOkFile(path.join(moved, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW)), '打完补丁的文件语法合法（node --check）');

console.log('\n=== G2. 新旧载体都定义了同名 isAuthenticated → 只打新载体，旧载体字节不变 ===');
const bothCarriers = makeSandbox('both-carriers', {
  authCarrier: 'new',
  authSnippet: AUTH_SNIPPET_NEW,
  oldCarrierBody: AUTH_SNIPPET, // 旧载体里塞回带旧签名的方法，模拟"上游把方法搬回去"的对抗场景
  dshVersion: '0.2.3-alpha.2',
});
const oldBefore = fs.readFileSync(path.join(bothCarriers, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_OLD), 'utf8');
const rG2 = runPatch(bothCarriers);
const oldAfter = fs.readFileSync(path.join(bothCarriers, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_OLD), 'utf8');
ok(rG2.status === 0, `退出码为 0（实际 ${rG2.status}）`);
ok(oldAfter === oldBefore, '旧载体（含同名方法）字节未被改动');
ok(!/auth-bypass-all/.test(oldAfter), '旧载体没有被注入 return true');
ok(/auth-bypass-all/.test(fs.readFileSync(path.join(bothCarriers, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8')),
  '补丁只落在新载体上');

console.log('\n=== G3. dsh-client-remote-connection 含同名方法 → 绝不可被改动 ===');
const withRemote = makeSandbox('with-remote', {
  authCarrier: 'new', authSnippet: AUTH_SNIPPET_NEW, remoteConn: REMOTE_CONN_SNIPPET, dshVersion: '0.2.3-alpha.2',
});
const rcBefore = fs.readFileSync(path.join(withRemote, 'lib/node_modules/@deepseek-ai', REMOTE_CONN_FILE), 'utf8');
const rG3 = runPatch(withRemote);
const rcAfter = fs.readFileSync(path.join(withRemote, 'lib/node_modules/@deepseek-ai', REMOTE_CONN_FILE), 'utf8');
ok(rG3.status === 0, `退出码为 0（实际 ${rG3.status}）`);
ok(rcAfter === rcBefore && !/auth-bypass-all/.test(rcAfter),
  'dsh-client-remote-connection 的 isAuthenticated 未被误打（Remote 登录不受影响）');

console.log('\n=== H. 新载体锚点失效，但旧载体仍有可命中的旧签名 → 必须 FATAL（fail-closed，不得回落） ===');
// 这是对抗验证的 P1：若实现按"锚点不中就试下一个载体"，就会把补丁打进运行时根本不加载的旧文件，
// 然后报"全部必需补丁已生效"并退出 0 —— 401 拦截照旧，闸门形同虚设。
const movedBroken = makeSandbox('moved-broken', {
  authCarrier: 'new', breakAuth: true, oldCarrierBody: AUTH_SNIPPET, dshVersion: '0.2.3-alpha.2',
});
const rH = runPatch(movedBroken);
const rHOut = (rH.stdout || '') + (rH.stderr || '');
ok(rH.status !== 0, `退出码非 0（实际 ${rH.status}）`);
ok(/\[FATAL\]/.test(rHOut) && /auth-bypass/.test(rHOut), '输出指出未命中的补丁名 auth-bypass');
const oldOnFail = fs.readFileSync(path.join(movedBroken, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_OLD), 'utf8');
ok(!/auth-bypass-all/.test(oldOnFail), '新载体失配时未回落到旧载体（旧载体仍保持原样）');
ok(!/全部必需补丁已生效/.test(rHOut), '未打印"全部必需补丁已生效"');

console.log('\n=== I. marker 在但文件被截断（语法损坏）→ 不得静默放行 ===');
const truncated = makeSandbox('truncated', { authCarrier: 'new', authSnippet: AUTH_SNIPPET_NEW, dshVersion: '0.2.3-alpha.2' });
runPatch(truncated); // 先正常打一次，产生 .dsh-orig 备份
const truncPath = path.join(truncated, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW);
const goodContent = fs.readFileSync(truncPath, 'utf8');
fs.writeFileSync(truncPath, goodContent.slice(0, goodContent.indexOf('auth-bypass-all') + 40)); // 截断在 marker 之后
const rI = runPatch(truncated);
const iAfter = fs.readFileSync(truncPath, 'utf8');
ok(rI.status === 0, `退出码为 0（实际 ${rI.status}）`);
ok(syntaxOkFile(truncPath), '损坏文件已被自愈为语法合法');
ok(/auth-bypass-all \*\/ return true;/.test(iAfter), '自愈后补丁仍真实生效（不只是 marker 残留）');

console.log('\n=== J. 注释/字符串里先出现同名字符串 → 必须打在真实方法体上，不能打在诱饵上 ===');
const decoy = makeSandbox('decoy', {
  authCarrier: 'new',
  authSnippet: [
    '// 历史注释里提到过 isAuthenticated(request, secure = false) { 这个写法',
    'const doc = "isAuthenticated(request, secure = false) {";',
    'class BrowserAuth {',
    '\tisAuthenticated(request, secure = false) {',
    '\t\treturn false;',
    '\t}',
    '}',
    'export { BrowserAuth };',
    ''
  ].join('\n'),
  dshVersion: '0.2.3-alpha.2',
});
const rJ = runPatch(decoy);
const jAfter = fs.readFileSync(path.join(decoy, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8');
ok(rJ.status === 0, `退出码为 0（实际 ${rJ.status}）`);
ok((jAfter.match(/auth-bypass-all/g) || []).length === 1, '只注入一处（没打在注释/字符串诱饵上）');
ok(/\n\t\t\/\* dsh-patch: auth-bypass-all \*\/ return true;/.test(jAfter), '注入点在真实方法体内（带两段缩进）');
ok(syntaxOkFile(path.join(decoy, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW)), '诱饵场景下语法仍合法');
ok(jAfter.indexOf('const doc =') < jAfter.indexOf('dsh-patch: auth-bypass-all'), '注入点位于字符串诱饵之后');

console.log('\n=== K. 同时存在「嵌套」与「提升」两棵树 → 两棵都必须打上 ===');
// SEARCH_DIRS 在真实镜像里通常同时命中 dsh/node_modules/@deepseek-ai 与 @deepseek-ai 两处；
// 若用全局 appliedPatches 判断「已完成」，第二棵会被整段跳过，而运行时加载的很可能正是它。
const twoBase = path.join(os.tmpdir(), 'dsh-two-' + Date.now());
for (const [label, mods] of [['nested', path.join(twoBase, 'dsh/node_modules/@deepseek-ai')], ['hoisted', twoBase]]) {
  const w = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3-alpha.2' }));
  w(AUTH_CARRIER_NEW, AUTH_SNIPPET_NEW);
  w('dsh-client-ui-layout/lib/client.js', LOOPBACK_SNIPPET + '\n');
  w('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  void label;
}
const rK = spawnSync('node', [SCRIPT], {
  env: { ...process.env, DSH_PATCH_ONLY_DIR: twoBase },
  encoding: 'utf8'
});
const nestedAfter = fs.readFileSync(path.join(twoBase, 'dsh/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8');
const hoistedAfter = fs.readFileSync(path.join(twoBase, AUTH_CARRIER_NEW), 'utf8');
ok(rK.status === 0, `退出码为 0（实际 ${rK.status}）`);
ok(/auth-bypass-all/.test(nestedAfter), '嵌套树已打补丁');
ok(/auth-bypass-all/.test(hoistedAfter), '提升树也已打补丁（未被全局状态挡住）');

console.log('\n=== L. 行首模板字符串诱饵 → 必须打真实方法，不能被字符串骗过 ===');
const tplDecoy = makeSandbox('tpl-decoy', {
  authCarrier: 'new',
  authSnippet: [
    'const tpl = `',
    'isAuthenticated(request, secure = false) {',
    '`;',
    'class BrowserAuth {',
    '\tisAuthenticated(request, secure = false) {',
    '\t\treturn false;',
    '\t}',
    '}',
    'export { BrowserAuth };',
    ''
  ].join('\n'),
  dshVersion: '0.2.3-alpha.2',
});
const rL = runPatch(tplDecoy);
const lAfter = fs.readFileSync(path.join(tplDecoy, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8');
ok(rL.status === 0, `退出码为 0（实际 ${rL.status}）`);
ok((lAfter.match(/auth-bypass-all/g) || []).length === 1, '只注入一处（没打进模板字符串）');
ok(lAfter.indexOf('dsh-patch: auth-bypass-all') > lAfter.indexOf('class BrowserAuth'), '注入点在真实类内');

console.log('\n=== M. 入口被改名成 .cjs（包在、lib/index.js 不在）→ 按包判代际，不得回落旧载体 ===');
const renamed = makeSandbox('renamed-cjs', {
  authCarrier: 'new',
  authSnippet: AUTH_SNIPPET_NEW,
  oldCarrierBody: AUTH_SNIPPET,
  dshVersion: '0.2.3-alpha.2',
});
// 把新载体入口改成 .cjs
const newEntry = path.join(renamed, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW);
const newCjs = newEntry.replace(/\.js$/, '.cjs');
fs.renameSync(newEntry, newCjs);
const rM = runPatch(renamed);
const mOld = fs.readFileSync(path.join(renamed, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_OLD), 'utf8');
ok(rM.status === 0, `退出码为 0（实际 ${rM.status}）`);
ok(/auth-bypass-all/.test(fs.readFileSync(newCjs, 'utf8')), '.cjs 入口被打上（靠 lib/ 目录扫描找到）');
ok(!/auth-bypass-all/.test(mOld), '旧载体未被误打（没有因为入口改名就回落到旧代）');

console.log('\n=== N. marker 残留但 return true 被删 → 必须补回 ===');
const markerOnly = makeSandbox('marker-no-return', {
  authCarrier: 'new',
  authSnippet: AUTH_SNIPPET_NEW.replace('\t\treturn false;', '\t\t/* dsh-patch: auth-bypass-all */\n\t\treturn false;'),
  dshVersion: '0.2.3-alpha.2',
});
const rN = runPatch(markerOnly);
const nAfter = fs.readFileSync(path.join(markerOnly, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8');
ok(rN.status === 0, `退出码为 0（实际 ${rN.status}）`);
ok(/\/\* dsh-patch: auth-bypass-all \*\/ return true;/.test(nAfter), '已补回 return true（不再只认 marker）');

console.log('\n=== O. 备份本身已带补丁 + 当前文件损坏 → 还原后不得二次注入 ===');
const MARKED_VALID = AUTH_SNIPPET_NEW.replace('\t\treturn false;', '\t\t/* dsh-patch: auth-bypass-all */ return true;\n\t\treturn false;');
const bakSandbox = makeSandbox('bak-marked', {
  authCarrier: 'new',
  authSnippet: MARKED_VALID.slice(0, MARKED_VALID.indexOf('return false;') + 13), // 截断成语法坏
  dshVersion: '0.2.3-alpha.2',
});
fs.writeFileSync(path.join(bakSandbox, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW + '.dsh-orig'), MARKED_VALID);
const rO = runPatch(bakSandbox);
const oAfter = fs.readFileSync(path.join(bakSandbox, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW), 'utf8');
ok(rO.status === 0, `退出码为 0（实际 ${rO.status}）`);
ok((oAfter.match(/auth-bypass-all/g) || []).length === 1, '还原后未二次注入（marker 仍为 1 处）');
ok(syntaxOkFile(path.join(bakSandbox, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER_NEW)), '还原后语法合法');

console.log('\n=== P. 同文件出现两处行首候选 → 歧义必须 fail-closed ===');
const ambiguous = makeSandbox('ambiguous', {
  authCarrier: 'new',
  authSnippet: AUTH_SNIPPET_NEW + 'class Other {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n',
  dshVersion: '0.2.3-alpha.2',
});
const rP = runPatch(ambiguous);
const pOut = (rP.stdout || '') + (rP.stderr || '');
ok(rP.status !== 0, `退出码非 0（实际 ${rP.status}）`);
ok(/歧义/.test(pOut), '报错明确指出候选有歧义');
ok(!/全部必需补丁已生效/.test(pOut), '未打印"全部必需补丁已生效"');

console.log('\n=== Q. 方法前有含「转义反引号」的模板串 → 不得误判为在字符串里（假 FATAL） ===');
// 反引号计数奇偶这种启发式在这里会挂：模板串里出现转义反引号时反引号个数为奇数，
// 旧实现会认为后续全部代码都在模板字符串内 → 所有候选被跳过 → [FATAL] → 容器起不来。
// 一个与鉴权毫无关系的合法写法就能把容器搞挂，所以改用最小词法扫描。
const tplBacktick = makeSandbox("tpl-backtick", {
  authCarrier: "new",
  authSnippet: 'const BANNER = `a\\`b`;\n' + AUTH_SNIPPET_NEW,
  dshVersion: "0.2.3-alpha.2",
});
const rQ = runPatch(tplBacktick);
const qPath = path.join(tplBacktick, "lib/node_modules/@deepseek-ai", AUTH_CARRIER_NEW);
const qAfter = fs.readFileSync(qPath, "utf8");
ok(rQ.status === 0, `退出码为 0（实际 ${rQ.status}）`);
ok(/\/\* dsh-patch: auth-bypass-all \*\/ return true;/.test(qAfter), "补丁已注入（未被误判为在模板字符串内）");
ok(syntaxOkFile(qPath), "夹具语法合法");

console.log('\n=== F. 0.2.1-alpha.3 客户端文件再次改名（未知名） → 应 FATAL ===');
const a3unknown = makeSandbox('a3unknown', { clientFile: 'dsh-client-connection/lib/client.unknown.js', dshVersion: '0.2.1-alpha.3' });
const rF = runPatch(a3unknown);
const rFOut = (rF.stdout || '') + (rF.stderr || '');
ok(rF.status !== 0, `退出码非 0（实际 ${rF.status}）`);
ok(/\[FATAL\]/.test(rFOut), '输出包含 [FATAL]');
ok(/client-loopback/.test(rFOut), '指出未命中的补丁名 client-loopback');

fs.rmSync(good, { recursive: true, force: true });
fs.rmSync(bad, { recursive: true, force: true });
fs.rmSync(newer, { recursive: true, force: true });
fs.rmSync(vtree, { recursive: true, force: true });
fs.rmSync(a3browser, { recursive: true, force: true });
fs.rmSync(a3unknown, { recursive: true, force: true });
fs.rmSync(moved, { recursive: true, force: true });
fs.rmSync(movedBroken, { recursive: true, force: true });
fs.rmSync(bothCarriers, { recursive: true, force: true });
fs.rmSync(withRemote, { recursive: true, force: true });
fs.rmSync(truncated, { recursive: true, force: true });
fs.rmSync(decoy, { recursive: true, force: true });
fs.rmSync(twoBase, { recursive: true, force: true });
fs.rmSync(tplDecoy, { recursive: true, force: true });
fs.rmSync(renamed, { recursive: true, force: true });
fs.rmSync(markerOnly, { recursive: true, force: true });
fs.rmSync(bakSandbox, { recursive: true, force: true });
fs.rmSync(ambiguous, { recursive: true, force: true });
fs.rmSync(tplBacktick, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
