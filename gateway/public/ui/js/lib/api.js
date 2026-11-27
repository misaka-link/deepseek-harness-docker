/**
 * Unified HTTP API client with timeout protection, 401 redirect, structured error translation,
 * and overlap-guarded polling.
 */

import { translateError, t } from './i18n.js';

const DEFAULT_TIMEOUT_MS = 20000;

export function getBoot() {
  return window.__DSHD_BOOT__ || {};
}

export function getAdminPath() {
  const boot = getBoot();
  const fromBoot = boot.adminPath;
  const fromEl = document.getElementById('app')?.dataset?.adminPath;
  const raw = fromBoot || fromEl || window.location.pathname.replace(/\/+$/, '') || '/admin';
  const clean = String(raw).replace(/\/+$/, '');
  return clean.startsWith('/') ? clean : '/' + clean;
}

export function getVncPath() {
  const boot = getBoot();
  return boot.vncPath || '/vnc/';
}

export function getVariant() {
  const boot = getBoot();
  return boot.variant || document.documentElement.dataset.variant || 'full';
}

export function isMiniVariant(caps = null) {
  if (caps && caps.desktop && caps.desktop.supported === false) return true;
  if (caps && caps.variant === 'mini') return true;
  return getVariant() === 'mini';
}

export function redirectToLogin() {
  const target = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  window.location.href = `/login?redirect=${target}`;
}

/**
 * Perform a JSON API request with normalized return shape.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, skipAuthRedirect?: boolean, json?: any }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any, errorCode?: string, params?: any, message: string }>}
 */
export async function apiJson(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, skipAuthRedirect = false, json, headers, signal, ...rest } = opts;
  const reqHeaders = new Headers(headers || {});
  let body = rest.body;
  if (json !== undefined) {
    if (!reqHeaders.has('Content-Type')) reqHeaders.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }

  let effectiveSignal = signal;
  if (!effectiveSignal && timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    effectiveSignal = AbortSignal.timeout(timeoutMs);
  }

  try {
    const res = await fetch(url, {
      ...rest,
      headers: reqHeaders,
      body,
      signal: effectiveSignal
    });

    if (res.status === 401 && !skipAuthRedirect) {
      redirectToLogin();
      return {
        ok: false,
        status: 401,
        data: null,
        errorCode: 'AUTH_REQUIRED',
        message: t('errors', 'AUTH_REQUIRED')
      };
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      const txt = await res.text().catch(() => '');
      try { data = JSON.parse(txt); } catch { data = txt ? { raw: txt } : null; }
    }

    const ok = res.ok && (!data || data.ok !== false);
    const errorCode = data && data.errorCode ? String(data.errorCode) : undefined;
    const params = data && data.params ? data.params : undefined;
    const message = ok
      ? (data && data.message ? String(data.message) : '')
      : translateError({ errorCode, params, error: data && data.error }, res.status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN');

    return { ok, status: res.status, data, errorCode, params, message };
  } catch (err) {
    const isAbort = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const errorCode = isAbort ? 'OPERATION_TIMEOUT' : 'NETWORK_ERROR';
    return {
      ok: false,
      status: 0,
      data: null,
      errorCode,
      params: isAbort ? { op: 'request' } : undefined,
      message: t('errors', errorCode, isAbort ? { op: 'HTTP' } : null)
    };
  }
}

/**
 * Guard an async polling function so concurrent invocations never overlap.
 */
export function guardedPoll(fn) {
  let inFlight = false;
  return async function (...args) {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await fn.apply(this, args);
    } finally {
      inFlight = false;
    }
  };
}
