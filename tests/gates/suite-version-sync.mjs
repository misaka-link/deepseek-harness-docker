#!/usr/bin/env node
/**
 * suite-version-sync.mjs — Suite project version single-source-of-truth gate.
 *
 * Verifies consistency across:
 *   - build.sh#PROJ_VER
 *   - version.json#latest.version
 *   - gateway/package.json#version
 *   - CHANGELOG.md
 *   - Dockerfile ARG/ENV injection
 *   - .github/workflows/docker-build.yml
 *   - gateway/index.js + gateway/src/** (single reader & no hardcoded version fallbacks)
 *   - gateway/public/ui/js/** + gateway/public/templates/**
 *   - README.md version declaration & image tags
 *
 * Usage: node tests/gates/suite-version-sync.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function walkFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => ent.name.endsWith(ext))) out.push(full);
  }
  return out;
}

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

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const buildSh = read('build.sh');
const versionJson = JSON.parse(read('version.json'));
const gatewayPkg = JSON.parse(read('gateway/package.json'));
const changelog = read('CHANGELOG.md');
const dockerfile = read('Dockerfile');

const projVerMatch = buildSh.match(/^PROJ_VER="([^"]+)"/m);
const buildVer = projVerMatch ? projVerMatch[1].trim() : '';
const metaVer = String(versionJson?.latest?.version ?? '').trim();
const pkgVer = String(gatewayPkg?.version ?? '').trim();

console.log('\n=== A. 工程版本号单一事实源（三处权威副本一致） ===');
console.log('   build.sh#PROJ_VER        = ' + (buildVer || '(缺失)'));
console.log('   version.json#latest      = ' + (metaVer || '(缺失)'));
console.log('   gateway/package.json     = ' + (pkgVer || '(缺失)'));

ok(SEMVER.test(buildVer), 'build.sh#PROJ_VER 为合法 semver', buildVer);
ok(SEMVER.test(metaVer), 'version.json#latest.version 为合法 semver', metaVer);
ok(SEMVER.test(pkgVer), 'gateway/package.json#version 为合法 semver', pkgVer);
ok(buildVer === metaVer, 'build.sh#PROJ_VER === version.json#latest.version', `${buildVer} vs ${metaVer}`);
ok(buildVer === pkgVer, 'build.sh#PROJ_VER === gateway/package.json#version', `${buildVer} vs ${pkgVer}`);
ok(metaVer === pkgVer, 'version.json#latest.version === gateway/package.json#version', `${metaVer} vs ${pkgVer}`);
ok(changelog.includes('## [v' + buildVer + ']'), 'CHANGELOG.md 存在 v' + buildVer + ' 小节');

console.log('\n=== B. 构建期注入链路（build.sh / CI → Dockerfile ARG → ENV） ===');
ok(/^ARG SUITE_VERSION=/m.test(dockerfile), 'Dockerfile 声明 ARG SUITE_VERSION');
ok(/DSH_SUITE_VERSION=\$/m.test(dockerfile), 'Dockerfile 将 ARG 落为 ENV DSH_SUITE_VERSION');

const buildInvocations = (buildSh.match(/\$\{BUILD_CMD\}/g) || []).length;
const suiteBuildArgs = (buildSh.match(/--build-arg SUITE_VERSION="\$\{PROJ_VER\}"/g) || []).length;
ok(buildInvocations > 0, 'build.sh 存在镜像构建调用（${BUILD_CMD}）', String(buildInvocations));
ok(
  suiteBuildArgs === buildInvocations,
  '每处构建都注入 --build-arg SUITE_VERSION="${PROJ_VER}"',
  `${suiteBuildArgs} 处注入 / ${buildInvocations} 处构建`
);

const workflowRaw = read('.github/workflows/docker-build.yml');
const workflowNoComments = workflowRaw.replace(/^[ \t]*#.*$/gm, '');
ok(
  /SUITE_VERSION=\$\{\{\s*needs\.check-version\.outputs\.project_version\s*\}\}/.test(workflowNoComments),
  'CI build-args 注入 SUITE_VERSION=needs.check-version.outputs.project_version'
);

console.log('\n=== C. 禁止硬编码版本兜底与唯一读取入口 ===');
const gatewayJsFiles = [
  path.join(root, 'gateway/index.js'),
  ...walkFiles(path.join(root, 'gateway/src'), ['.js'])
].filter((p) => fs.existsSync(p));

const literalInFunction = (relFile, fnName) => {
  const src = read(relFile);
  const i = src.indexOf(fnName);
  if (i < 0) return '(函数不存在)';
  const body = src.slice(i, i + 500).replace(/\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
  const m = body.match(/return\s+['"]v?\d+\.\d+\.\d+[^'"]*['"]/);
  return m ? m[0].trim() : '';
};

ok(
  literalInFunction('gateway/src/dsh/version-service.js', 'getLocalProjectVersion') === '',
  'gateway/src/dsh/version-service.js#getLocalProjectVersion() 无硬编码版本兜底'
);
ok(
  literalInFunction('gateway/src/backup/state.js', 'getCurrentProjectVersion') === '',
  'gateway/src/backup/state.js#getCurrentProjectVersion() 无硬编码版本兜底'
);

const projectVersions = new Set([
  ...Object.keys(versionJson.history || {}),
  buildVer,
  metaVer,
  pkgVer
].filter(Boolean));

// Bare project versions: 0.x.y or 1.x.y+ (excluding 0.0.0 sentinel and 1.6.0 noVNC revision)
const isBareProjectVersion = (v) =>
  (/^[01]\.\d+\.\d+$/.test(v) && v !== '0.0.0' && v !== '1.6.0') || projectVersions.has(v);

const hardcodedReturns = [];
const orFallbacks = [];
for (const abs of gatewayJsFiles) {
  const rel = path.relative(root, abs);
  const src = fs.readFileSync(abs, 'utf8');
  src.split('\n').forEach((line, idx) => {
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    const retM = code.match(/return\s+['"]v?(\d+\.\d+\.\d+[^'"]*)['"]/);
    if (retM && projectVersions.has(retM[1])) {
      hardcodedReturns.push(`${rel}:${idx + 1}  ${retM[0].trim()}`);
    }
    const orM = code.match(/\|\|\s*['"]v?(\d+\.\d+\.\d+[^'"]*)['"]/);
    if (orM && isBareProjectVersion(orM[1])) {
      orFallbacks.push(`${rel}:${idx + 1}  ${orM[0].trim()}`);
    }
  });
}

ok(
  hardcodedReturns.length === 0,
  'gateway/index.js 及 gateway/src/** 不存在 return 项目版本号字面量兜底',
  hardcodedReturns.join(' | ')
);
ok(
  orFallbacks.length === 0,
  'gateway/index.js 及 gateway/src/** 不存在 || 项目版本号兜底',
  orFallbacks.join(' | ')
);

const OWN_PKG_READ = [
  /path\.join\(__dirname,\s*['"](?:\.\.\/)*package\.json['"]\)/,
  /require\(\s*['"](?:\.\/|\.\.\/)+package\.json['"]\s*\)/,
  /readFileSync\(\s*__dirname\s*\+\s*['"]\/?(?:\.\.\/)*package\.json['"]/
];
const pkgReaders = gatewayJsFiles
  .filter((abs) => OWN_PKG_READ.some((re) => re.test(fs.readFileSync(abs, 'utf8'))))
  .map((abs) => path.relative(root, abs));

ok(
  pkgReaders.length === 1 && pkgReaders[0] === 'gateway/src/core/project-version.js',
  '仅 gateway/src/core/project-version.js 读取 gateway/package.json',
  pkgReaders.join(', ') || '(无)'
);

const uiJsFiles = walkFiles(path.join(root, 'gateway/public/ui/js'), ['.js']);
const uiTemplates = walkFiles(path.join(root, 'gateway/public/templates'), ['.html']);

const uiOrFallbacks = [];
for (const abs of [...uiJsFiles, ...uiTemplates]) {
  const rel = path.relative(root, abs);
  const src = fs.readFileSync(abs, 'utf8');
  src.split('\n').forEach((line, idx) => {
    const code = line.replace(/\/\/.*$/, '');
    const m = code.match(/\|\|\s*['"]v?(\d+\.\d+\.\d+)['"]/);
    if (m) uiOrFallbacks.push(`${rel}:${idx + 1}  ${m[0].trim()}`);
  });
}
ok(
  uiOrFallbacks.length === 0,
  '前端 UI 与模板无 || 具体版本号兜底',
  uiOrFallbacks.join(' | ')
);

const formatJs = read('gateway/public/ui/js/lib/format.js');
ok(
  /export\s+function\s+suiteVerText\(/.test(formatJs) && formatJs.includes("return 'v未知'"),
  'gateway/public/ui/js/lib/format.js#suiteVerText() 无值时回落到未知而非假版本号'
);

const staticPlaceholders = [];
for (const abs of uiTemplates) {
  const rel = path.relative(root, abs);
  const html = fs.readFileSync(abs, 'utf8');
  for (const m of html.matchAll(/id="([^"]*(?:Project|Version|SuiteVer|Ver)[^"]*)"[^>]*>([^<]*)</gi)) {
    if (/\d+\.\d+\.\d+/.test(m[2])) {
      staticPlaceholders.push(`${rel}#${m[1]}=${m[2].trim()}`);
    }
  }
}
ok(
  staticPlaceholders.length === 0,
  'HTML 模板版本占位元素不写死静态版本号',
  staticPlaceholders.join(' | ')
);

console.log('\n=== D. 运行期取值链实测（真实 require） ===');
const pv = require(path.join(root, 'gateway/src/core/project-version.js'));
const quiet = (fn) => {
  const orig = console.warn;
  console.warn = () => {};
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
  const noEnvDesc = quiet(() => pv.describeProjectVersion());
  ok(noEnvDesc.version === pkgVer, '未注入 ENV 时取 gateway/package.json#version', String(noEnvDesc.version));
  ok(noEnvDesc.versionMismatch === false, '未注入 ENV 时无版本冲突标记');

  process.env.DSH_SUITE_VERSION = pkgVer;
  pv.resetWarnings();
  const matchingEnv = quiet(() => pv.describeProjectVersion());
  const matchingEnvSrc = matchingEnv.sources.find((s) => s.source === 'env');
  ok(
    matchingEnv.version === pkgVer && Boolean(matchingEnvSrc?.adopted) && matchingEnvSrc?.conflict === false && !matchingEnv.versionMismatch,
    'ENV 与镜像内 package.json 一致时正常采信且无冲突',
    JSON.stringify(matchingEnv)
  );

  process.env.DSH_SUITE_VERSION = 'v' + pkgVer;
  pv.resetWarnings();
  const vPrefix = quiet(() => pv.describeProjectVersion());
  ok(
    vPrefix.version === pkgVer && !vPrefix.versionMismatch,
    'ENV 带前导 v 且与镜像一致时归一化采信',
    String(vPrefix.version)
  );

  const staleCandidate = pkgVer === '0.2.15' ? '0.2.14' : '0.2.15';
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  process.env.DSH_SUITE_VERSION = staleCandidate;
  pv.resetWarnings();
  const staleDesc = pv.describeProjectVersion();
  console.warn = origWarn;
  const staleEnvSrc = staleDesc.sources.find((s) => s.source === 'env');
  const stalePkgSrc = staleDesc.sources.find((s) => s.source === 'package.json');
  ok(
    staleDesc.version === pkgVer,
    'Issue #24: 陈旧容器 ENV 与 package.json 不一致时拒绝采信旧 ENV 并降级采用镜像内版本',
    `expected ${pkgVer}, got ${staleDesc.version}`
  );
  ok(
    staleDesc.versionMismatch === true && staleDesc.envConflict === true,
    'Issue #24: 陈旧容器 ENV 触发 versionMismatch=true 与 envConflict=true'
  );
  ok(
    staleEnvSrc?.adopted === false && staleEnvSrc?.conflict === true && stalePkgSrc?.adopted === true && stalePkgSrc?.conflict === false,
    'Issue #24: versionSources 准确标记 env.conflict=true/adopted=false 且 package.json.adopted=true'
  );
  ok(
    warnings.some((w) => w.includes('不一致') && w.includes('force-recreate')),
    '多来源不一致时会产生告警并提示重建容器',
    warnings.join(' | ') || '(无告警)'
  );

  process.env.DSH_SUITE_VERSION = 'not-a-version';
  pv.resetWarnings();
  const badEnv = quiet(() => pv.describeProjectVersion());
  ok(
    badEnv.version === pkgVer && badEnv.versionMismatch === false,
    '非法 ENV 被忽略并回落到 package.json（不误标为版本冲突）',
    String(badEnv.version)
  );

  const desc = quiet(() => pv.describeProjectVersion());
  ok(
    desc.sources.length === 3 && desc.sources.map((s) => s.source).join(',') === 'env,package.json,version.json',
    'describeProjectVersion() 覆盖 env / package.json / version.json 三源'
  );
  ok(
    desc.sources.every((s) => typeof s.conflict === 'boolean' && typeof s.adopted === 'boolean'),
    'describeProjectVersion() 每个来源均携带 adopted 与 conflict 布尔字段'
  );
  ok(desc.sources.filter((s) => s.adopted).length >= 1, '至少一个来源被采纳');
} finally {
  restoreEnv();
}

console.log('\n=== E. CI 工作流内的项目版本默认值 ===');
const wfVersionHits = new Set();
for (const m of workflowNoComments.matchAll(/default:\s*['"]?v?(\d+\.\d+\.\d+)['"]?/g)) {
  wfVersionHits.add(m[1]);
}
for (const m of workflowNoComments.matchAll(/PROJ_VER="v?(\d+\.\d+\.\d+)"/g)) {
  wfVersionHits.add(m[1]);
}
for (const m of workflowNoComments.matchAll(/(?<![\d.])(0\.\d+\.\d+)(?![\d.])/g)) {
  wfVersionHits.add(m[1]);
}
const wfLiterals = [...wfVersionHits];
const wfStale = wfLiterals.filter((v) => v !== buildVer);
ok(wfLiterals.length > 0, 'docker-build.yml 中存在项目版本默认值', wfLiterals.join(', '));
ok(
  wfStale.length === 0,
  'docker-build.yml 内所有项目版本默认值均等于 ' + buildVer,
  wfStale.length ? `陈旧默认值: ${wfStale.join(', ')}（应为 ${buildVer}）` : ''
);

console.log('\n=== F. 运行时兜底契约 ===');
const pvSrc = read('gateway/src/core/project-version.js');
ok(/return null/.test(pvSrc), 'project-version.js 在全部来源不可用时返回 null');
ok(/@returns \{string\|null\}/.test(pvSrc), 'project-version.js 文档标注返回 {string|null}');
const vsSrc = read('gateway/src/dsh/version-service.js');
ok(
  /getLocalProjectVersion\(\)\s*\{\s*\n\s*return resolveProjectVersion\(\);/.test(vsSrc),
  'version-service.js#getLocalProjectVersion() 直接委派给 resolveProjectVersion()'
);
const stateSrc = read('gateway/src/backup/state.js');
ok(
  /function getCurrentProjectVersion\(\)\s*\{\s*\n\s*return resolveProjectVersion\(\);/.test(stateSrc),
  'backup/state.js#getCurrentProjectVersion() 直接委派给 resolveProjectVersion()'
);

console.log('\n=== G. README 与 version.json 归档一致性 ===');
const readmeRaw = read('README.md');
// Exempt explicit legacy-archive notice blocks (e.g. pointing legacy <=0.2.2 users to low/:v0.2.16)
const readmeForTags = readmeRaw.replace(
  /<!--\s*legacy-archive-tags-start\s*-->[\s\S]*?<!--\s*legacy-archive-tags-end\s*-->/g,
  ''
);

const readmeTagTokens = [
  ...new Set(
    (readmeForTags.match(/:(v?\d+\.\d+\.\d+(?:-(?:mini|market|full))?)(?=[\s`'")|,]|$)/g) || [])
      .map((t) => t.slice(1).replace(/^v/, ''))
  )
];
const bareTokens = readmeTagTokens.filter((t) => /^\d+\.\d+\.\d+$/.test(t));
const variantTokens = readmeTagTokens.filter((t) => /^\d+\.\d+\.\d+-(mini|market|full)$/.test(t));
const staleBare = bareTokens.filter((t) => t !== buildVer);
const staleVariant = variantTokens.filter(
  (t) => t !== `${buildVer}-mini` && t !== `${buildVer}-market` && t !== `${buildVer}-full`
);

ok(
  bareTokens.length > 0 && staleBare.length === 0,
  'README 中所有主线裸项目版本标签均为 ' + buildVer,
  '陈旧标签: ' + (staleBare.join(', ') || '(无)')
);
ok(
  variantTokens.length > 0 && staleVariant.length === 0,
  'README 中所有主线 -mini/-market/-full 项目版本标签均为 ' + buildVer,
  '陈旧标签: ' + (staleVariant.join(', ') || '(无)')
);

const readmeDecl = (readmeRaw.match(/本项目工程版本\s*`(\d+\.\d+\.\d+)`/) || [])[1];
ok(
  readmeDecl === buildVer,
  'README 顶部「本项目工程版本」声明为 ' + buildVer,
  '实际: ' + (readmeDecl || '(未找到声明)')
);

const tagVariants = [buildVer, `${buildVer}-mini`, `${buildVer}-market`, `${buildVer}-full`].filter((t) =>
  readmeTagTokens.includes(t)
);
ok(
  tagVariants.length === 4,
  'README 覆盖 :X / :X-mini / :X-market / :X-full 四种项目版本标签',
  '仅命中 ' + (tagVariants.join(', ') || '(无)')
);

const history = versionJson.history || {};
ok(Object.keys(history).length > 0, 'version.json#history 非空');
ok(
  !Object.prototype.hasOwnProperty.call(history, metaVer),
  'latest.version 不得同时出现在 history 中',
  metaVer
);
ok(
  Object.keys(history).every((k) => SEMVER.test(k)),
  'history 的键均为合法 semver',
  Object.keys(history).filter((k) => !SEMVER.test(k)).join(', ')
);

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ 套件版本号一致性门禁通过（${pass}/${pass + fail}）`
    : `❌ 套件版本号一致性门禁失败：${fail} 项未通过 / 共 ${pass + fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
