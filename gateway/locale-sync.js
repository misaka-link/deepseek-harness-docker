'use strict';

/**
 * DSH 语言设置 -> 容器 Chromium UI 语言 同步模块（Issue #17）
 *
 * 权威来源：DSH 将语言偏好持久化在 profile 补丁 YAML 的 locale 条目：
 *   - id: locale
 *     name: "@deepseek-ai/dsh-client-locale"
 *     config:
 *       preference: zh
 *
 * 补丁层合并顺序：profile patch 先、Home 级 $DSH_DIR/cordis.patch.yml 后（后者优先级更高）。
 * profile 层按 web 优先取第一个非空；同一文件内重复 id 时 DSH 以最后一条为准，本模块同语义。
 */

const fs = require('fs');
const path = require('path');

/** Chromium 可用的 UI 语言白名单（与 Dockerfile 保留的 .pak 对应）。 */
const CHROMIUM_LOCALES = new Set([
  'zh-CN', 'zh-TW', 'en-US', 'en-GB',
  'ja', 'es', 'fr', 'de', 'ru', 'pt-BR'
]);

/** DSH 内置 8 语言 -> Chromium locale 的显式映射。 */
const DSH_LOCALE_MAP = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN',
  'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-hant': 'zh-TW',
  en: 'en-US', 'en-us': 'en-US', 'en-gb': 'en-GB',
  ja: 'ja', 'ja-jp': 'ja',
  es: 'es', 'es-es': 'es',
  fr: 'fr', 'fr-fr': 'fr',
  de: 'de', 'de-de': 'de',
  ru: 'ru', 'ru-ru': 'ru',
  pt: 'pt-BR', 'pt-br': 'pt-BR'
};

/**
 * 把 DSH / POSIX 语言标识归一化为 Chromium 的 --lang 值。
 * 无法识别时返回空串（调用方回退）。
 */
function mapLocale(id) {
  if (id === undefined || id === null) return '';
  const s = String(id).trim().replace(/_/g, '-').toLowerCase();
  if (!s) return '';
  if (DSH_LOCALE_MAP[s]) return DSH_LOCALE_MAP[s];
  if (s.startsWith('zh')) {
    return (s.includes('tw') || s.includes('hk') || s.includes('hant')) ? 'zh-TW' : 'zh-CN';
  }
  if (s.startsWith('en')) {
    return (s.includes('gb') || s.includes('uk')) ? 'en-GB' : 'en-US';
  }
  for (const base of ['ja', 'es', 'fr', 'de', 'ru']) {
    if (s === base || s.startsWith(base + '-')) return base;
  }
  if (s === 'pt' || s.startsWith('pt-')) return 'pt-BR';
  return CHROMIUM_LOCALES.has(id) ? id : '';
}

function dshDir() {
  if (process.env.DSH_DIR) return process.env.DSH_DIR;
  const home = process.env.DSH_HOME || '/root';
  // DSH_HOME 可能已经指向 harness home（以 .dsh 结尾），避免拼成 /root/.dsh/.dsh
  if (path.basename(home) === '.dsh') return home;
  // 兼容两种语义：DSH_HOME 直接是 harness home（其下有 profiles），或容器 home（其下有 .dsh/profiles）
  try { if (fs.statSync(path.join(home, 'profiles')).isDirectory()) return home; } catch { /* ignore */ }
  try { if (fs.statSync(path.join(home, '.dsh', 'profiles')).isDirectory()) return path.join(home, '.dsh'); } catch { /* ignore */ }
  return path.join(home, '.dsh');
}

/** profile 层补丁，web 优先（低 -> 高，但读取时取第一个非空）。 */
function profilePatches() {
  const profilesDir = path.join(dshDir(), 'profiles');
  const out = [];
  try {
    const names = fs.readdirSync(profilesDir);
    names.sort((a, b) => (a === 'web' ? -1 : b === 'web' ? 1 : a.localeCompare(b)));
    for (const name of names) {
      const p = path.join(profilesDir, name, 'cordis.patch.yml');
      try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* ignore */ }
    }
  } catch { /* profiles 目录不存在 */ }
  if (!out.length) out.push(path.join(profilesDir, 'web', 'cordis.patch.yml'));
  return out;
}

/** Home 级补丁（DSH 0.1.7+ 最高优先级层）。 */
function homePatches() {
  return [path.join(dshDir(), 'cordis.patch.yml')];
}

/** 轻量兜底解析：只认 locale 条目的 config.preference；重复条目取最后一条。 */
function parseLocalePreferenceMinimal(text) {
  const lines = String(text || '').split(/\r?\n/);
  let inLocale = false;
  let inConfig = false;
  let last = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*-\s*id:\s*['"]?locale['"]?\s*$/.test(line)) {
      inLocale = true;
      inConfig = false;
      continue;
    }
    if (!inLocale) continue;
    if (/^\s*-\s*id:/.test(line)) { inLocale = false; inConfig = false; continue; }
    if (/^\s*config:\s*$/.test(line)) { inConfig = true; continue; }
    if (inConfig) {
      const m = /^\s*preference:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
      if (m) last = m[1];
    }
  }
  return last;
}

let _warnedFallback = false;
function warnFallback(reason) {
  if (_warnedFallback) return;
  _warnedFallback = true;
  console.warn('[locale-sync] ' + reason + '，改用逐行兜底解析 locale.preference');
}

function parseLocalePreferenceWithYaml(text) {
  let yaml;
  try { yaml = require('yaml'); } catch { warnFallback('未找到 yaml 模块'); return null; }
  try {
    const doc = yaml.parse(text);
    if (!Array.isArray(doc)) return '';
    let pref = '';
    for (const e of doc) {
      if (e && typeof e === 'object' && e.id === 'locale') {
        const p = e.config && e.config.preference;
        if (typeof p === 'string' && p) pref = p;
      }
    }
    return pref;
  } catch {
    warnFallback('YAML 解析失败');
    return null; // 交给兜底解析
  }
}

function readPrefFromFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const viaYaml = parseLocalePreferenceWithYaml(text);
  return viaYaml === null ? parseLocalePreferenceMinimal(text) : viaYaml;
}

let _cache = { key: '', value: '' };

/**
 * 读取 DSH 当前语言偏好（原始 id，如 zh / en / ja）。
 * profile 层 web 优先取第一个非空；Home 层覆盖 profile 层。
 * 带 mtime 缓存；文件变化后自动失效。
 */
function readLocalePreference() {
  const profiles = profilePatches();
  const homes = homePatches();
  const files = [...profiles, ...homes];
  const parts = files.map((f) => {
    try { return f + ':' + fs.statSync(f).mtimeMs; } catch { return f + ':missing'; }
  });
  const key = parts.join('|');
  if (key === _cache.key) return _cache.value;

  let profilePref = '';
  for (const f of profiles) {
    const v = readPrefFromFile(f);
    if (v) { profilePref = v; break; } // web 优先
  }
  let homePref = '';
  for (const f of homes) {
    const v = readPrefFromFile(f);
    if (v) homePref = v; // 后者覆盖
  }
  const value = homePref || profilePref;
  _cache = { key, value };
  return value;
}

/**
 * 解析当前应使用的 Chromium UI 语言。
 * 优先级：DSH_DESKTOP_LANG（运维显式覆盖）> DSH 语言偏好 > 环境 LANG/LANGUAGE。
 */
function resolveDesktopLang() {
  const override = mapLocale(process.env.DSH_DESKTOP_LANG);
  if (override) return override;

  const pref = mapLocale(readLocalePreference());
  if (pref) return pref;

  const envLoc = process.env.LANGUAGE || process.env.LC_ALL || process.env.LANG || '';
  const first = String(envLoc).split(':')[0].split('.')[0];
  return mapLocale(first) || 'en-US';
}

function __resetCacheForTest() {
  _cache = { key: '', value: '' };
  _warnedFallback = false;
}

module.exports = {
  CHROMIUM_LOCALES,
  DSH_LOCALE_MAP,
  mapLocale,
  resolveDesktopLang,
  readLocalePreference,
  parseLocalePreferenceMinimal,
  __resetCacheForTest
};
