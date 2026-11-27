'use strict';

/**
 * DSH user preference reader (locale & ui-theme) + Chromium --lang mapping.
 *
 * Reads $DSH_DIR/profiles/<profile>/cordis.patch.yml (web profile first)
 * and $DSH_DIR/cordis.patch.yml (Home layer overrides profile layer; last
 * duplicate id within the same file wins), with mtime-based caching.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');

const CHROMIUM_LOCALES = new Set([
  'zh-CN', 'zh-TW', 'en-US', 'en-GB',
  'ja', 'es', 'fr', 'de', 'ru', 'pt-BR'
]);

const DSH_LOCALE_MAP = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN',
  'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-hant': 'zh-TW',
  en: 'en-US', 'en-us': 'en-US', 'en-gb': 'en-GB',
  ja: 'ja', 'ja-jp': 'ja',
  es: 'es', 'es-es': 'es',
  fr: 'fr', 'fr-fr': 'fr',
  de: 'de', 'de-de': 'de',
  ru: 'ru', 'ru-ru': 'ru',
  pt: 'pt-BR', 'pt-br': 'pt-BR', 'pt-pt': 'pt-BR'
};

const VALID_THEMES = new Set(['light', 'dark', 'system']);

/**
 * Normalize a DSH or POSIX locale identifier to a Chromium --lang tag.
 * Returns '' if unrecognized.
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

function normalizeThemeValue(val) {
  const s = String(val ?? '').trim().toLowerCase();
  return VALID_THEMES.has(s) ? s : '';
}

function resolveEffectiveDshDir() {
  if (process.env.DSH_DIR) return process.env.DSH_DIR;
  const home = paths.getDshHome();
  if (path.basename(home) === '.dsh') return home;
  try {
    if (fs.statSync(path.join(home, 'profiles')).isDirectory()) return home;
  } catch {}
  return paths.getDshDir();
}

function profilePatches(dir) {
  const profilesDir = path.join(dir, 'profiles');
  const out = [];
  try {
    const names = fs.readdirSync(profilesDir);
    names.sort((a, b) => (a === 'web' ? -1 : b === 'web' ? 1 : a.localeCompare(b)));
    for (const name of names) {
      const p = path.join(profilesDir, name, 'cordis.patch.yml');
      try {
        if (fs.statSync(p).isFile()) out.push(p);
      } catch {}
    }
  } catch {}
  if (!out.length) {
    out.push(path.join(profilesDir, 'web', 'cordis.patch.yml'));
  }
  return out;
}

function homePatches(dir) {
  return [path.join(dir, 'cordis.patch.yml')];
}

/**
 * Lightweight line-based fallback parser for cordis.patch.yml entries.
 * Extracts config.preference for a given entry id; last duplicate id wins.
 */
function parseEntryPreferenceMinimal(text, targetId) {
  const lines = String(text || '').split(/\r?\n/);
  const idRe = new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]?\\s*$');
  let inTarget = false;
  let inConfig = false;
  let last = '';
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (idRe.test(line)) {
      inTarget = true;
      inConfig = false;
      continue;
    }
    if (!inTarget) continue;
    if (/^\s*-\s*id:/.test(line)) {
      inTarget = false;
      inConfig = false;
      continue;
    }
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (inConfig) {
      const m = /^\s*preference:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
      if (m) last = m[1];
    }
  }
  return last;
}

function parseLocalePreferenceMinimal(text) {
  return parseEntryPreferenceMinimal(text, 'locale');
}

function parseThemePreferenceMinimal(text) {
  return normalizeThemeValue(parseEntryPreferenceMinimal(text, 'ui-theme'));
}

let _warnedFallback = false;
function warnFallback(reason) {
  if (_warnedFallback) return;
  _warnedFallback = true;
  console.warn('[dsh-prefs] ' + reason + '，改用逐行兜底解析 cordis.patch.yml');
}

function parsePrefsWithYaml(text) {
  let yaml;
  try {
    yaml = require('yaml');
  } catch {
    warnFallback('未找到 yaml 模块');
    return null;
  }
  try {
    const doc = yaml.parse(text);
    if (!Array.isArray(doc)) return { locale: '', theme: '' };
    let locale = '';
    let theme = '';
    for (const e of doc) {
      if (!e || typeof e !== 'object') continue;
      const p = e.config && e.config.preference;
      if (typeof p !== 'string' || !p) continue;
      if (e.id === 'locale') locale = p;
      else if (e.id === 'ui-theme') {
        const norm = normalizeThemeValue(p);
        if (norm) theme = norm;
      }
    }
    return { locale, theme };
  } catch {
    warnFallback('YAML 解析失败');
    return null;
  }
}

function readPrefsFromFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { locale: '', theme: '' };
  }
  const viaYaml = parsePrefsWithYaml(text);
  if (viaYaml !== null) return viaYaml;
  return {
    locale: parseLocalePreferenceMinimal(text),
    theme: parseThemePreferenceMinimal(text)
  };
}

let _cache = { key: '', value: { locale: '', theme: '' } };

/**
 * Read DSH locale and ui-theme preferences together with mtime caching.
 * Profile layer: web first, first non-empty wins per field.
 * Home layer: overrides profile layer.
 */
function readDshPrefs() {
  const dir = resolveEffectiveDshDir();
  const profiles = profilePatches(dir);
  const homes = homePatches(dir);
  const files = [...profiles, ...homes];
  const parts = files.map((f) => {
    try {
      return f + ':' + fs.statSync(f).mtimeMs;
    } catch {
      return f + ':missing';
    }
  });
  const key = dir + '||' + parts.join('|');
  if (key === _cache.key) return { ..._cache.value };

  let profileLocale = '';
  let profileTheme = '';
  for (const f of profiles) {
    const v = readPrefsFromFile(f);
    if (!profileLocale && v.locale) profileLocale = v.locale;
    if (!profileTheme && v.theme) profileTheme = v.theme;
    if (profileLocale && profileTheme) break;
  }

  let homeLocale = '';
  let homeTheme = '';
  for (const f of homes) {
    const v = readPrefsFromFile(f);
    if (v.locale) homeLocale = v.locale;
    if (v.theme) homeTheme = v.theme;
  }

  const value = {
    locale: homeLocale || profileLocale,
    theme: homeTheme || profileTheme
  };
  _cache = { key, value };
  return { ...value };
}

function readLocalePreference() {
  return readDshPrefs().locale;
}

function readThemePreference() {
  return readDshPrefs().theme;
}

/**
 * Resolve effective Chromium --lang flag value.
 * Precedence: DSH_DESKTOP_LANG env override > DSH locale preference > LANG/LANGUAGE env > en-US.
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
  _cache = { key: '', value: { locale: '', theme: '' } };
  _warnedFallback = false;
}

module.exports = {
  CHROMIUM_LOCALES,
  DSH_LOCALE_MAP,
  mapLocale,
  readDshPrefs,
  readLocalePreference,
  readThemePreference,
  resolveDesktopLang,
  parseLocalePreferenceMinimal,
  parseThemePreferenceMinimal,
  __resetCacheForTest
};
