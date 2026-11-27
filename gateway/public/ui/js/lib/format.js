/**
 * Locale-aware formatting helpers, password strength evaluator, and suiteVerText().
 */

export const WEAK_PASSWORDS = new Set([
  'admin', 'password', '123456', '12345678', '123456789', 'qwertyuiop',
  '111111', '11111111', '000000', '00000000', '888888', '666666', 'deepseek'
]);

/**
 * Format container suite version safely. Never fabricates a fallback version number.
 * @param {string|null|undefined} v
 * @param {(ns: string, key: string) => string} [tFn]
 * @returns {string}
 */
export function suiteVerText(v, tFn = null) {
  const s = String(v || '').trim().replace(/^v/, '');
  if (s && s !== 'unknown' && s !== 'null' && s !== 'undefined') {
    return 'v' + s;
  }
  if (typeof tFn === 'function') {
    const localized = tFn('common', 'suiteVerUnknown');
    if (localized && localized !== 'suiteVerUnknown') return localized;
  }
  return 'v未知';
}

export function formatBytes(bytes, localeTag = 'en-US') {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = num;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  const decimals = idx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2;
  try {
    return `${new Intl.NumberFormat(localeTag, { maximumFractionDigits: decimals }).format(val)} ${units[idx]}`;
  } catch {
    return `${val.toFixed(decimals)} ${units[idx]}`;
  }
}

export function formatDateTime(value, localeTag = 'en-US') {
  if (!value) return '--';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  try {
    return new Intl.DateTimeFormat(localeTag, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function formatTime(value, localeTag = 'en-US') {
  if (!value) return '--';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  try {
    return new Intl.DateTimeFormat(localeTag, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

export function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Evaluate password strength into 0..4 levels for live meter feedback.
 * @param {string} pwd
 * @returns {{ score: 0|1|2|3|4, isBlacklisted: boolean, classes: number, length: number }}
 */
export function evaluatePasswordStrength(pwd) {
  const s = String(pwd || '');
  if (!s) return { score: 0, isBlacklisted: false, classes: 0, length: 0 };
  const isBlacklisted = WEAK_PASSWORDS.has(s.toLowerCase());
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[^A-Za-z0-9]/.test(s)) classes++;

  if (isBlacklisted || s.length < 6) {
    return { score: 1, isBlacklisted, classes, length: s.length };
  }
  if (s.length >= 16 || (s.length >= 12 && classes >= 3)) {
    return { score: 4, isBlacklisted: false, classes, length: s.length };
  }
  if (s.length >= 10 && classes >= 3) {
    return { score: 3, isBlacklisted: false, classes, length: s.length };
  }
  if (s.length >= 8 && classes >= 2) {
    return { score: 2, isBlacklisted: false, classes, length: s.length };
  }
  return { score: 1, isBlacklisted: false, classes, length: s.length };
}

export async function copyToClipboard(text) {
  const str = String(text ?? '');
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
