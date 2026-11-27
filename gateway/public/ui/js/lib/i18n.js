/**
 * 8-Language Native i18n Engine.
 * Mirrors DSH locale set: zh, en, ja, es, fr, de, ru, pt.
 * Supports 'dsh' (follow DSH settings) + instant no-reload live language switching.
 */

import { interpolate } from './dom.js';
import { readUiCookie, writeUiCookie, onDshPrefsSync } from './theme.js';

export const SUPPORTED_LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'];

export const LOCALE_META = {
  zh: { id: 'zh', label: '简体中文', short: '中文', tag: 'zh-CN' },
  en: { id: 'en', label: 'English', short: 'EN', tag: 'en-US' },
  ja: { id: 'ja', label: '日本語', short: '日本語', tag: 'ja' },
  es: { id: 'es', label: 'Español', short: 'ES', tag: 'es' },
  fr: { id: 'fr', label: 'Français', short: 'FR', tag: 'fr' },
  de: { id: 'de', label: 'Deutsch', short: 'DE', tag: 'de' },
  ru: { id: 'ru', label: 'Русский', short: 'RU', tag: 'ru' },
  pt: { id: 'pt', label: 'Português (Brasil)', short: 'PT', tag: 'pt-BR' }
};

const dictCache = new Map();
const localeListeners = new Set();

let localeMode = 'dsh'; // 'dsh' | one of SUPPORTED_LOCALES
let currentLang = 'en';
let dshLocale = '';
let uiRev = 'latest';
let activeDict = {};
let fallbackEnDict = {};

export function normalizeLocale(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const lower = raw.trim().toLowerCase().replace(/_/g, '-');
  if (SUPPORTED_LOCALES.includes(lower)) return lower;
  const base = lower.split('-')[0];
  if (SUPPORTED_LOCALES.includes(base)) return base;
  return '';
}

function detectBrowserLocale() {
  const list = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language || 'en'];
  for (const item of list) {
    const matched = normalizeLocale(item);
    if (matched) return matched;
  }
  return 'en';
}

function resolveEffectiveLocale() {
  if (localeMode !== 'dsh' && SUPPORTED_LOCALES.includes(localeMode)) {
    return localeMode;
  }
  const fromDsh = normalizeLocale(dshLocale);
  if (fromDsh) return fromDsh;
  const boot = window.__DSHD_BOOT__ || {};
  const fromBoot = normalizeLocale(boot.lang);
  if (fromBoot) return fromBoot;
  return detectBrowserLocale();
}

async function loadDictionary(lang) {
  const id = normalizeLocale(lang) || 'en';
  if (dictCache.has(id)) return dictCache.get(id);
  const url = `/__ui/${encodeURIComponent(uiRev)}/i18n/${id}/index.js`;
  const mod = await import(url);
  const dict = mod.default || mod;
  dictCache.set(id, dict);
  return dict;
}

export async function initI18n() {
  const boot = window.__DSHD_BOOT__ || {};
  uiRev = boot.rev || 'latest';
  dshLocale = (boot.dshPrefs && boot.dshPrefs.locale) || '';

  const cookie = readUiCookie();
  const rawMode = cookie.l || boot.langCookie || 'dsh';
  localeMode = rawMode === 'dsh' || SUPPORTED_LOCALES.includes(rawMode) ? rawMode : 'dsh';

  const target = resolveEffectiveLocale();
  currentLang = target;

  // Load target dictionary (and keep en warm as fallback if target !== 'en')
  try {
    activeDict = await loadDictionary(target);
  } catch {
    activeDict = await loadDictionary('en').catch(() => ({}));
    currentLang = 'en';
  }

  if (currentLang !== 'en') {
    loadDictionary('en').then((d) => { fallbackEnDict = d; }).catch(() => {});
  } else {
    fallbackEnDict = activeDict;
  }

  document.documentElement.lang = getLocaleTag();

  onDshPrefsSync(async ({ dshLocale: nextDshLocale }) => {
    dshLocale = nextDshLocale || '';
    if (localeMode === 'dsh') {
      const resolved = resolveEffectiveLocale();
      if (resolved !== currentLang) {
        await applyResolvedLocale(resolved);
      }
    }
  });

  return currentLang;
}

async function applyResolvedLocale(lang) {
  const target = normalizeLocale(lang) || 'en';
  try {
    activeDict = await loadDictionary(target);
    currentLang = target;
  } catch {
    return;
  }
  document.documentElement.lang = getLocaleTag();
  for (const fn of localeListeners) {
    try { fn({ lang: currentLang, mode: localeMode, tag: getLocaleTag() }); } catch {}
  }
}

export async function setLocaleMode(mode) {
  const clean = mode === 'dsh' ? 'dsh' : normalizeLocale(mode);
  if (!clean) return;
  localeMode = clean;
  writeUiCookie({ l: clean });
  const target = resolveEffectiveLocale();
  await applyResolvedLocale(target);
}

export function getLocale() {
  return currentLang;
}

export function getLocaleMode() {
  return localeMode;
}

export function getLocaleTag(lang = currentLang) {
  return (LOCALE_META[lang] && LOCALE_META[lang].tag) || 'en-US';
}

export function subscribeLocale(fn) {
  localeListeners.add(fn);
  return () => localeListeners.delete(fn);
}

export function hasKey(ns, key) {
  return Boolean(
    (activeDict && activeDict[ns] && Object.prototype.hasOwnProperty.call(activeDict[ns], key)) ||
    (fallbackEnDict && fallbackEnDict[ns] && Object.prototype.hasOwnProperty.call(fallbackEnDict[ns], key))
  );
}

/**
 * Translate a key from a namespace and interpolate `{param}` safely.
 * @param {string} ns
 * @param {string} key
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
export function t(ns, key, params = null) {
  const raw =
    (activeDict && activeDict[ns] && activeDict[ns][key]) ??
    (fallbackEnDict && fallbackEnDict[ns] && fallbackEnDict[ns][key]) ??
    key;
  return interpolate(raw, params);
}

/**
 * Resolve a localized error message from a backend API response or Error object.
 */
export function translateError(resOrErr, fallbackKey = 'UNKNOWN') {
  if (!resOrErr) return t('errors', fallbackKey);
  const code = resOrErr.errorCode || (resOrErr.data && resOrErr.data.errorCode);
  const params = resOrErr.params || (resOrErr.data && resOrErr.data.params) || null;
  if (code && hasKey('errors', code)) {
    return t('errors', code, params);
  }
  const rawMsg =
    (resOrErr.data && resOrErr.data.error) ||
    resOrErr.error ||
    resOrErr.message;
  if (rawMsg) return String(rawMsg);
  return t('errors', fallbackKey);
}
