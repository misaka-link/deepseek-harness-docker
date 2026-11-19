/**
 * suite-version-sync-test.mjs —— 套件工程版本「单一事实源」一致性门禁（Issue #19 回归测试）
 *
 * 背景：工程版本号曾有 5 份副本 + 2 处硬编码兜底（build.sh#PROJ_VER / version.json#latest.version /
 * gateway/package.json#version / CI 默认值 / version-service.js 的 '0.2.13' / backup-service.js 的 '0.1.9'）。
 * v0.2.14 发版时漏改 gateway/package.json，镜像内出现「本地 0.2.13 vs version.json 0.2.14」自相矛盾，
 * 管理面板永久误报「发现新版」，且错版本号被写进每个快照 sidecar 元数据。
 *
 * 本测试是发版硬门禁：CI（.github/workflows/docker-build.yml 的 check-version 作业）与本地
 * scripts/local-prepush-guard.mjs 都会执行；任一项失败即禁止发版/推送。
 *
 * 用法: node scripts/suite-version-sync-test.mjs
 * 退出码: 0 = 一致；1 = 存在漂移
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ── 采集三处权威副本 ─────────────────────────────────────────────────────
const buildSh = read('build.sh');
const versionJson = JSON.parse(read('version.json'));
const gatewayPkg = JSON.parse(read('gateway/package.json'));
const changelog = read('CHANGELOG.md');
const dockerfile = read('Dockerfile');
const adminHtml = read('gateway/public/admin.html');

const projVerMatch = buildSh.match(/^PROJ_VER="([^"]+)"/m);
const buildVer = projVerMatch ? projVerMatch[1].trim() : '';
const metaVer = String(versionJson?.latest?.version ?? '').trim();
const pkgVer = String(gatewayPkg?.version ?? '').trim();

console.log('\n=== A. 工程版本号单一事实源（三处副本必须完全一致） ===');
console.log('   build.sh#PROJ_VER        = ' + (buildVer || '(缺失)'));
console.log('   version.json#latest      = ' + (metaVer || '(缺失)'));
console.log('   gateway/package.json     = ' + (pkgVer || '(缺失)'));

ok(SEMVER.test(buildVer), 'build.sh#PROJ_VER 为合法 semver', buildVer);
ok(SEMVER.test(metaVer), 'version.json#latest.version 为合法 semver', metaVer);
ok(SEMVER.test(pkgVer), 'gateway/package.json#version 为合法 semver', pkgVer);
ok(buildVer === metaVer, 'build.sh#PROJ_VER === version.json#latest.version', buildVer + ' vs ' + metaVer);
ok(buildVer === pkgVer, 'build.sh#PROJ_VER === gateway/package.json#version', buildVer + ' vs ' + pkgVer + '（发版漏改 gateway/package.json 即此项失败）');
ok(metaVer === pkgVer, 'version.json#latest.version === gateway/package.json#version', metaVer + ' vs ' + pkgVer);
ok(changelog.includes('## [v' + buildVer + ']'), 'CHANGELOG.md 存在 v' + buildVer + ' 小节');

console.log('\n=== B. 构建期注入链路（build.sh → Dockerfile ARG → ENV → 运行期读取） ===');
ok(/^ARG SUITE_VERSION=/m.test(dockerfile), 'Dockerfile 声明 ARG SUITE_VERSION');
ok(/DSH_SUITE_VERSION=\$/m.test(dockerfile), 'Dockerfile 将 ARG 落为 ENV DSH_SUITE_VERSION');

// build.sh 通过 BUILD_CMD 变量分派（docker build / docker buildx build），故按 ${BUILD_CMD} 调用点计数
const buildInvocations = (buildSh.match(/\$\{BUILD_CMD\}/g) || []).length;
const suiteBuildArgs = (buildSh.match(/--build-arg SUITE_VERSION="\$\{PROJ_VER\}"/g) || []).length;
ok(buildInvocations > 0, 'build.sh 存在镜像构建调用（${BUILD_CMD}）', String(buildInvocations));
ok(suiteBuildArgs === buildInvocations,
  '每处构建都注入 --build-arg SUITE_VERSION="${PROJ_VER}"',
  suiteBuildArgs + ' 处注入 / ' + buildInvocations + ' 处构建');

// 本地 build.sh 与 CI 是两条独立构建路径：CI 走 docker/build-push-action 的 build-args，
// 漏了 SUITE_VERSION 就会让「构建期注入」在正式发版镜像里变成空值（P1-2 回归点）。
const workflowForArgs = read('.github/workflows/docker-build.yml').replace(/^[ \t]*#.*$/gm, '');
ok(/SUITE_VERSION=\$\{\{\s*needs\.check-version\.outputs\.project_version\s*\}\}/.test(workflowForArgs),
  'CI build-args 注入 SUITE_VERSION=needs.check-version.outputs.project_version',
  'docker-build.yml 的 build-args 缺少 SUITE_VERSION 注入');

console.log('\n=== C. 禁止硬编码版本兜底（Issue #19 的直接复发点） ===');
const gatewayFiles = fs.readdirSync(path.join(root, 'gateway')).filter((f) => f.endsWith('.js'));

// C1：项目版本读取函数体内不得出现 return 字面量（这是 Issue #19 的直接复发点）
const literalInFunction = (file, fnName) => {
  const src = read('gateway/' + file);
  const i = src.indexOf(fnName);
  if (i < 0) return '(函数不存在)';
  const body = src.slice(i, i + 700).replace(/\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
  const m = body.match(/return\s+['"]v?\d+\.\d+\.\d+[^'"]*['"]/);
  return m ? m[0].trim() : '';
};
const vsLiteral = literalInFunction('version-service.js', 'getLocalProjectVersion');
const bsLiteral = literalInFunction('backup-service.js', 'getCurrentProjectVersion');
ok(vsLiteral === '', 'version-service.getLocalProjectVersion() 内无硬编码版本兜底', vsLiteral);
ok(bsLiteral === '', 'backup-service.getCurrentProjectVersion() 内无硬编码版本兜底', bsLiteral);

// C2：全量扫描——不得 return 任何「本项目历史/当前版本号」字面量（DSH 引擎版本不在本集合内）
const projectVersions = new Set([
  ...Object.keys(versionJson.history || {}),
  buildVer, metaVer, pkgVer
].filter(Boolean));
const hardcoded = [];
for (const f of gatewayFiles) {
  const src = read('gateway/' + f);
  src.split('\n').forEach((line, i) => {
    // 跳过注释：本仓大量「修复前…」注释会合法地引用历史版本号
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    const m = code.match(/return\s+['"]v?(\d+\.\d+\.\d+[^'"]*)['"]/);
    if (m && projectVersions.has(m[1])) hardcoded.push('gateway/' + f + ':' + (i + 1) + '  ' + m[0].trim());
  });
}
ok(hardcoded.length === 0,
  'gateway/*.js 中不存在「return \'本项目版本号\'」式兜底（DSH 引擎版本兜底不在此列）',
  hardcoded.join(' | '));

// C3：调用点兜底同样致命——`fn() || \'0.2.13\'` 是 Issue #19 的另一种复发形态
// （读不到就用一个具体旧版本号顶上，误报照样发生）。project-version.js 除外：它只用 \'\' 表示读取失败。
// 判定口径：**裸 0.x.y** 即视为「本项目版本号兜底」——不依赖 history 集合，
// 否则 `|| '0.2.15'`（尚未归档的未来版本）会漏检。以下不属于本项目版本轴，故不拦：
//   · 带预发布后缀的 DSH 引擎版本（0.2.2-rc.3 / 0.1.2-rc.1 …）
//   · '0.0.0' —— semver 最小哨兵值，用于比较基线，不是可发布的版本号
//   · 非 0 开头（1.6.0 NOVNC 修订号、127.0.0.1 等）
const isBareProjectVersion = (v) => /^0\.\d+\.\d+$/.test(v) && v !== '0.0.0';
const orFallbacks = [];
for (const f of gatewayFiles) {
  const src = read('gateway/' + f);
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    const m = code.match(/\|\|\s*['"]v?(\d+\.\d+\.\d+[^'"]*)['"]/);
    if (m && isBareProjectVersion(m[1])) orFallbacks.push('gateway/' + f + ':' + (i + 1) + '  ' + m[0].trim());
  });
}
ok(orFallbacks.length === 0,
  'gateway/*.js 中不存在「|| \'本项目版本号\'」式调用点兜底',
  orFallbacks.join(' | '));

// 唯一读取入口：把「读取本项目 package.json」的各种写法都算上（__dirname / require / 相对路径），
// 否则改成 require('./package.json') 即可绕过（评审 M10）。
const OWN_PKG_READ = [
  /path\.join\(__dirname,\s*['"]package\.json['"]\)/,
  /require\(\s*['"]\.\.?\/package\.json['"]\s*\)/,
  /readFileSync\(\s*__dirname\s*\+\s*['"]\/?package\.json['"]/
];
const pkgReaders = gatewayFiles.filter((f) => OWN_PKG_READ.some((re) => re.test(read('gateway/' + f))));
ok(pkgReaders.length === 1 && pkgReaders[0] === 'project-version.js',
  '仅 gateway/project-version.js 读取本项目 package.json（唯一读取入口）',
  pkgReaders.join(', ') || '(无)');

// 任何 `|| '0.x.y'` 形式的回落都是「假版本号」，与写在哪个变量上无关
const adminOrFallbacks = [];
adminHtml.split('\n').forEach((line, i) => {
  const code = line.replace(/\/\/.*$/, '');
  const m = code.match(/\|\|\s*'v?(\d+\.\d+\.\d+)'/);
  if (m) adminOrFallbacks.push('admin.html:' + (i + 1) + '  ' + m[0].trim());
});
ok(adminOrFallbacks.length === 0,
  'admin.html 无「|| \'具体版本号\'」式套件版本回落（应为空串 + v未知）',
  adminOrFallbacks.join(' | '));

// 只查函数名等于没查：把函数体改成编造版本号也必须被抓到
ok(/function suiteVerText\(v\) \{\s*\n\s*return v \? 'v' \+ v : 'v未知';/.test(adminHtml),
  'suiteVerText() 实现为「有值加 v 前缀，无值显示 v未知」');

const staticPlaceholders = [...adminHtml.matchAll(/id="(headerProjectText|mobileMenuProjectVer|hubProjectCurrent|hubProjectLatest)"[^>]*>([^<]*)</g)]
  .filter((m) => /\d+\.\d+\.\d+/.test(m[2]));
ok(staticPlaceholders.length === 0,
  '套件版本静态占位不写死版本号（首屏不得闪出假版本）',
  staticPlaceholders.map((m) => m[1] + '=' + m[2]).join(' | '));

console.log('\n=== D. 运行期取值链实测（真实 require，非文本匹配） ===');
const pv = require(path.join(root, 'gateway/project-version.js'));
// 期望内的告警（如故意制造漂移）不应污染门禁输出，这里统一静音后单独断言
const quiet = (fn) => {
  const orig = console.warn;
  const buf = [];
  console.warn = (...a) => buf.push(a.join(' '));
  try { return fn(); } finally { console.warn = orig; }
};
const savedEnv = process.env.DSH_SUITE_VERSION;
const restoreEnv = () => {
  if (savedEnv === undefined) delete process.env.DSH_SUITE_VERSION;
  else process.env.DSH_SUITE_VERSION = savedEnv;
  pv.resetWarnings();
};

try {
  delete process.env.DSH_SUITE_VERSION;
  pv.resetWarnings();
  const noEnv = quiet(() => pv.resolveProjectVersion());
  ok(noEnv === pkgVer, '未注入 ENV 时取 gateway/package.json#version', String(noEnv));

  process.env.DSH_SUITE_VERSION = '9.9.9';
  pv.resetWarnings();
  const envFirst = quiet(() => pv.resolveProjectVersion());
  ok(envFirst === '9.9.9', '注入 ENV 时 ENV 优先级最高（构建期注入为权威）', String(envFirst));

  process.env.DSH_SUITE_VERSION = 'v9.9.9';
  pv.resetWarnings();
  const vPrefix = quiet(() => pv.resolveProjectVersion());
  ok(vPrefix === '9.9.9', 'ENV 带前导 v 时归一化', String(vPrefix));

  process.env.DSH_SUITE_VERSION = 'not-a-version';
  pv.resetWarnings();
  const badEnv = quiet(() => pv.resolveProjectVersion());
  ok(badEnv === pkgVer, '非法 ENV 被忽略并回落到 package.json', String(badEnv));

  const desc = quiet(() => pv.describeProjectVersion());
  ok(desc.sources.length === 3 && desc.sources.map((s) => s.source).join(',') === 'env,package.json,version.json',
    'describeProjectVersion() 覆盖 env / package.json / version.json 三源');
  ok(desc.sources.filter((s) => s.adopted).length >= 1, '至少一个来源被采纳（无「全部不可用却仍返回版本号」）');

  // 反向自证：漂移必须被检测到并告警（否则门禁只是摆设）
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  process.env.DSH_SUITE_VERSION = buildVer === '9.9.8' ? '9.9.7' : '9.9.8';
  pv.resetWarnings();
  pv.resolveProjectVersion();
  console.warn = origWarn;
  ok(warnings.some((w) => w.includes('不一致')),
    '多来源不一致时会产生告警（漂移可见，不静默取其一）',
    warnings.join(' | ') || '(无告警)');
} finally {
  restoreEnv();
}

console.log('\n=== E. CI 工作流内的项目版本默认值 ===');
// 去掉整行 YAML 注释：注释里引用历史版本号（如「0.2.13 vs 0.2.14」）是合法说明，不是陈旧默认值
const workflowSrc = read('.github/workflows/docker-build.yml').replace(/^[ \t]*#.*$/gm, '');
// 只认「本项目工程版本形态」的字面量：裸 semver 且主版本为 0（本项目仍在 0.x）。
// 借此排除 NOVNC_ASSET_REVISION（1.6.0）、端口/IP（127.0.0）以及带 -rc 的 DSH 引擎版本。
const wfLiterals = [...new Set((workflowSrc.match(/\b\d+\.\d+\.\d+\b/g) || []))]
  .filter((v) => /^0\.\d+\.\d+$/.test(v));
const wfStale = wfLiterals.filter((v) => v !== buildVer);
ok(wfLiterals.length > 0, 'docker-build.yml 中存在项目版本默认值', wfLiterals.join(', '));
ok(wfStale.length === 0,
  'docker-build.yml 内所有项目版本默认值均等于 ' + buildVer,
  wfStale.length ? '陈旧默认值: ' + wfStale.join(', ') + '（应为 ' + buildVer + '）' : '');

console.log('\n=== F. 运行时兜底契约 ===');
const pvSrc = read('gateway/project-version.js');
ok(/return null/.test(pvSrc), 'project-version.js 在全部来源不可用时返回 null（不编造版本号）');
ok(/@returns \{string\|null\}/.test(pvSrc), 'project-version.js 文档标注可能返回 null');
const vsSrc = read('gateway/version-service.js');
ok(/getLocalProjectVersion\(\) \{\s*\n\s*return resolveProjectVersion\(\);/.test(vsSrc),
  'version-service.getLocalProjectVersion() 直接委派给唯一读取入口');
const bsSrc = read('gateway/backup-service.js');
ok(/function getCurrentProjectVersion\(\) \{\s*\n\s*return resolveProjectVersion\(\);/.test(bsSrc),
  'backup-service.getCurrentProjectVersion() 直接委派给唯一读取入口');

console.log('\n=== G. 第 5 处副本（README）与 version.json 归档 ===');
const readme = read('README.md');
// 按「标签 token」逐类校验，而不是 includes()：否则同一版本号在 README 别处仍出现时，
// 局部漏改会被蒙混过关（评审 M12a / M12b 实测可绕过）。
// 只认 :0.x.y 与 :0.x.y-mini/-market；带 -rc/-alpha 后缀的是 DSH 引擎版本轴，不在此列。
// 注意必须允许 v 前缀：README 的表格里写的是 :v0.2.15 形式，
// 早先的正则只认 :0.x.y，导致「:v0.2.14」这种陈旧标签 40/40 全过却查不出来（子代理审查 P2-2）。
const readmeTagTokens = [...new Set((readme.match(/:(v?0\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/g) || []).map((t) => t.slice(1).replace(/^v/, '')))];
const bareTokens = readmeTagTokens.filter((t) => /^0\.\d+\.\d+$/.test(t));
const variantTokens = readmeTagTokens.filter((t) => /^0\.\d+\.\d+-(mini|market)$/.test(t));
const staleBare = bareTokens.filter((t) => t !== buildVer);
const staleVariant = variantTokens.filter((t) => t !== buildVer + '-mini' && t !== buildVer + '-market');
ok(bareTokens.length > 0 && staleBare.length === 0,
  'README 中所有裸项目版本标签均为 ' + buildVer,
  '陈旧标签: ' + (staleBare.join(', ') || '(无)'));
ok(variantTokens.length > 0 && staleVariant.length === 0,
  'README 中所有 -mini/-market 项目版本标签均为 ' + buildVer,
  '陈旧标签: ' + (staleVariant.join(', ') || '(无)'));
// README 顶部的「本项目工程版本 `X.Y.Z`」是无冒号裸声明，不在上面 :token 的采集范围内，
// 单独断言——否则「标签表改对、顶部声明漏改」这种半漏改仍会放行（评审 M12a）。
const readmeDecl = (readme.match(/本项目工程版本\s*`(\d+\.\d+\.\d+)`/) || [])[1];
ok(readmeDecl === buildVer,
  'README 顶部「本项目工程版本」声明为 ' + buildVer,
  '实际: ' + (readmeDecl || '(未找到声明)'));

const tagVariants = [buildVer, buildVer + '-mini', buildVer + '-market'].filter((t) => readmeTagTokens.includes(t));
ok(tagVariants.length === 3,
  'README 覆盖 :X / :X-mini / :X-market 三种项目版本标签',
  '仅命中 ' + (tagVariants.join(', ') || '(无)'));

const history = versionJson.history || {};
ok(Object.keys(history).length > 0, 'version.json#history 非空');
ok(!Object.prototype.hasOwnProperty.call(history, metaVer),
  'latest.version 不得同时出现在 history 中（避免同一版本重复归档）', metaVer);
ok(Object.keys(history).every((k) => SEMVER.test(k)), 'history 的键均为合法 semver',
  Object.keys(history).filter((k) => !SEMVER.test(k)).join(', '));

console.log('\n────────────────────────────────────────');
console.log(fail === 0
  ? '✅ 套件版本号一致性门禁通过（' + pass + '/' + (pass + fail) + '）'
  : '❌ 套件版本号一致性门禁失败：' + fail + ' 项未通过 / 共 ' + (pass + fail) + ' 项');
process.exit(fail === 0 ? 0 : 1);
