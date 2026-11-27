/**
 * Theme management, dsh_ui cookie persistence, and live /__ui/prefs synchronization.
 * Supports: 'dsh' (follow DSH settings), 'light', 'dark', 'system'.
 */

const COOKIE_NAME = 'dsh_ui';
const VALID_THEMES = new Set(['dsh', 'light', 'dark', 'system']);

let themeMode = 'dsh';
let dshThemePref = 'system';
let dshLocalePref = '';
let currentIsDark = false;
let mediaQuery = null;
let syncTimer = null;
let syncStarted = false;

const themeListeners = new Set();
const prefsListeners = new Set();

export function readUiCookie() {
  const out = { l: 'dsh', t: 'dsh' };
  try {
    const pairs = (document.cookie || '').split(';');
    for (const raw of pairs) {
      const idx = raw.indexOf('=');
      if (idx < 0) continue;
      const k = raw.slice(0, idx).trim();
      if (k !== COOKIE_NAME) continue;
      const val = decodeURIComponent(raw.slice(idx + 1).trim());
      for (const seg of val.split('|')) {
        const [pk, pv] = seg.split(':');
        if (pk === 'l' && pv) out.l = pv;
        if (pk === 't' && pv) out.t = pv;
      }
      break;
    }
  } catch {}
  return out;
}

export function writeUiCookie(patch = {}) {
  const cur = readUiCookie();
  const next = {
    l: patch.l !== undefined ? String(patch.l) : cur.l,
    t: patch.t !== undefined ? String(patch.t) : cur.t
  };
  const encoded = encodeURIComponent(`l:${next.l}|t:${next.t}`);
  try {
    document.cookie = `${COOKIE_NAME}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {}
  return next;
}

function resolveEffectivePreference() {
  if (themeMode === 'light' || themeMode === 'dark' || themeMode === 'system') {
    return themeMode;
  }
  if (dshThemePref === 'light' || dshThemePref === 'dark' || dshThemePref === 'system') {
    return dshThemePref;
  }
  return 'system';
}

function computeIsDark(pref) {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return Boolean(mediaQuery && mediaQuery.matches);
}

function syncMetaThemeColor() {
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      meta.setAttribute('content', bg);
    } else {
      meta.setAttribute('content', currentIsDark ? '#151517' : '#ffffff');
    }
  } catch {}
}

function applyThemeToDom() {
  const effectivePref = resolveEffectivePreference();
  const dark = computeIsDark(effectivePref);
  currentIsDark = dark;

  document.documentElement.setAttribute('data-ds-theme-source', effectivePref);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  if (document.body) {
    document.body.toggleAttribute('data-ds-dark-theme', dark);
  }
  syncMetaThemeColor();

  for (const fn of themeListeners) {
    try { fn({ mode: themeMode, effectivePref, isDark: dark }); } catch {}
  }
}

export function initTheme() {
  const boot = window.__DSHD_BOOT__ || {};
  const cookie = readUiCookie();

  const cookieTheme = VALID_THEMES.has(cookie.t) ? cookie.t : (VALID_THEMES.has(boot.themeCookie) ? boot.themeCookie : 'dsh');
  themeMode = cookieTheme;
  dshThemePref = (boot.dshPrefs && boot.dshPrefs.theme) || boot.themePref || 'system';
  dshLocalePref = (boot.dshPrefs && boot.dshPrefs.locale) || '';

  if (typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => {
      if (resolveEffectivePreference() === 'system') applyThemeToDom();
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onMediaChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onMediaChange);
    }
  }

  applyThemeToDom();
  startPrefsSync();
}

export function getThemeMode() {
  return themeMode;
}

export function getEffectiveTheme() {
  return {
    mode: themeMode,
    effectivePref: resolveEffectivePreference(),
    isDark: currentIsDark,
    dshTheme: dshThemePref
  };
}

export function setThemeMode(mode) {
  if (!VALID_THEMES.has(mode)) return;
  themeMode = mode;
  writeUiCookie({ t: mode });
  applyThemeToDom();
}

export function subscribeTheme(fn) {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

export function onDshPrefsSync(fn) {
  prefsListeners.add(fn);
  return () => prefsListeners.delete(fn);
}

export async function pollDshPrefs() {
  try {
    const res = await fetch('/__ui/prefs', {
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok) return null;

    const nextTheme = (data.dsh && data.dsh.theme) || (data.effective && data.effective.themePref) || '';
    const nextLocale = (data.dsh && data.dsh.locale) || '';

    const themeChanged = Boolean(nextTheme && nextTheme !== dshThemePref);
    const localeChanged = nextLocale !== dshLocalePref;

    if (nextTheme) dshThemePref = nextTheme;
    dshLocalePref = nextLocale;

    if (themeChanged && themeMode === 'dsh') {
      applyThemeToDom();
    }

    if (themeChanged || localeChanged) {
      for (const fn of prefsListeners) {
        try { fn({ dshTheme: dshThemePref, dshLocale: dshLocalePref, data }); } catch {}
      }
    }
    return data;
  } catch {
    return null;
  }
}

export function startPrefsSync() {
  if (syncStarted) return;
  syncStarted = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const cookie = readUiCookie();
      if (themeMode === 'dsh' || cookie.l === 'dsh') {
        pollDshPrefs();
      }
    }
  });

  syncTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    const cookie = readUiCookie();
    if (themeMode === 'dsh' || cookie.l === 'dsh') {
      pollDshPrefs();
    }
  }, 30000);
}

export function stopPrefsSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  syncStarted = false;
}
