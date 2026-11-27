'use strict';

/**
 * 8-language locale and 3-mode theme negotiation.
 *
 * Locale precedence:
 *   1. Cookie `dsh_ui` (`l:<lang>`, when valid and !== 'dsh')
 *   2. DSH `locale.preference` from cordis.patch.yml
 *   3. Request `Accept-Language` header (matched among 8 locales, or 'en' if header present with no match)
 *   4. Default fallback 'zh' when no Accept-Language header is present (CLI / headless compatibility)
 *
 * Theme precedence:
 *   1. Cookie `dsh_ui` (`t:<light|dark|system>`, when !== 'dsh')
 *   2. DSH `ui-theme.preference` from cordis.patch.yml
 *   3. Default 'system'
 */

const dshPrefs = require('../prefs/dsh-prefs');

const SUPPORTED_LOCALES = Object.freeze(['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']);
const SUPPORTED_SET = new Set(SUPPORTED_LOCALES);

const LOCALE_BCP47 = Object.freeze({
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja',
  es: 'es',
  fr: 'fr',
  de: 'de',
  ru: 'ru',
  pt: 'pt-BR'
});

const VALID_THEMES = new Set(['light', 'dark', 'system']);

function normalizeLocale(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim().replace(/_/g, '-').toLowerCase();
  if (!s) return '';
  if (SUPPORTED_SET.has(s)) return s;
  const base = s.split('-')[0];
  if (SUPPORTED_SET.has(base)) return base;
  return '';
}

function getBcp47Tag(lang) {
  const norm = normalizeLocale(lang) || 'en';
  return LOCALE_BCP47[norm] || 'en-US';
}

function parseCookieHeader(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parse `dsh_ui` cookie (`l:<lang>|t:<theme>`).
 */
function parseUiCookie(req) {
  const header = req && req.headers ? req.headers.cookie : '';
  const cookies = parseCookieHeader(header);
  const raw = cookies.dsh_ui || '';
  const result = { lang: 'dsh', theme: 'dsh' };
  if (!raw) return result;

  for (const seg of raw.split('|')) {
    const s = seg.trim();
    if (s.startsWith('l:')) {
      const val = s.slice(2).trim().toLowerCase();
      if (val === 'dsh') {
        result.lang = 'dsh';
      } else {
        const norm = normalizeLocale(val);
        if (norm) result.lang = norm;
      }
    } else if (s.startsWith('t:')) {
      const val = s.slice(2).trim().toLowerCase();
      if (val === 'dsh' || VALID_THEMES.has(val)) {
        result.theme = val;
      }
    }
  }
  return result;
}

/**
 * Parse HTTP Accept-Language header with quality weights.
 * Returns matched locale in SUPPORTED_LOCALES, or '' if no tag matches.
 */
function parseAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return '';
  const entries = header
    .split(',')
    .map((part, idx) => {
      const segs = part.trim().split(';');
      const tag = (segs[0] || '').trim();
      let q = 1;
      for (let i = 1; i < segs.length; i++) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(segs[i]);
        if (m) {
          const num = parseFloat(m[1]);
          if (Number.isFinite(num)) q = Math.max(0, Math.min(1, num));
        }
      }
      return { tag, q, idx };
    })
    .filter((e) => e.tag && e.tag !== '*' && e.q > 0)
    .sort((a, b) => (b.q !== a.q ? b.q - a.q : a.idx - b.idx));

  for (const entry of entries) {
    const exact = normalizeLocale(entry.tag);
    if (exact) return exact;
  }
  return '';
}

function negotiateLocale(req) {
  const uiCookie = parseUiCookie(req);
  if (uiCookie.lang && uiCookie.lang !== 'dsh' && SUPPORTED_SET.has(uiCookie.lang)) {
    return uiCookie.lang;
  }

  const dshLocale = normalizeLocale(dshPrefs.readLocalePreference());
  if (dshLocale) {
    return dshLocale;
  }

  const acceptLang = req && req.headers ? req.headers['accept-language'] : undefined;
  if (typeof acceptLang === 'string' && acceptLang.trim().length > 0) {
    return parseAcceptLanguage(acceptLang) || 'en';
  }

  return 'zh';
}

function negotiateTheme(req) {
  const uiCookie = parseUiCookie(req);
  if (uiCookie.theme && uiCookie.theme !== 'dsh' && VALID_THEMES.has(uiCookie.theme)) {
    return {
      source: 'cookie',
      preference: uiCookie.theme,
      rawCookie: uiCookie.theme
    };
  }

  const dshTheme = dshPrefs.readThemePreference();
  if (dshTheme && VALID_THEMES.has(dshTheme)) {
    return {
      source: 'dsh',
      preference: dshTheme,
      rawCookie: 'dsh'
    };
  }

  return {
    source: 'default',
    preference: 'system',
    rawCookie: 'dsh'
  };
}

function getUiPrefsSnapshot(req) {
  const prefs = dshPrefs.readDshPrefs();
  const uiCookie = parseUiCookie(req);
  const lang = negotiateLocale(req);
  const theme = negotiateTheme(req);
  const dshLocaleNorm = normalizeLocale(prefs.locale) || '';
  const dshThemeNorm = VALID_THEMES.has(prefs.theme) ? prefs.theme : '';

  return {
    dsh: {
      locale: dshLocaleNorm,
      theme: dshThemeNorm
    },
    cookie: {
      lang: uiCookie.lang,
      theme: uiCookie.theme
    },
    effective: {
      lang,
      langTag: getBcp47Tag(lang),
      themePref: theme.preference,
      themeSource: theme.source
    },
    supportedLocales: [...SUPPORTED_LOCALES]
  };
}

module.exports = {
  SUPPORTED_LOCALES,
  LOCALE_BCP47,
  normalizeLocale,
  getBcp47Tag,
  parseUiCookie,
  parseAcceptLanguage,
  negotiateLocale,
  negotiateTheme,
  getUiPrefsSnapshot
};
