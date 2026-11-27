'use strict';

/**
 * Structured AppError class and 8-language server-side message translation.
 */

const crypto = require('crypto');
const path = require('path');
const { SUPPORTED_LOCALES, normalizeLocale } = require('./negotiate');

const MESSAGES = Object.create(null);
for (const lang of SUPPORTED_LOCALES) {
  MESSAGES[lang] = require(path.join(__dirname, 'messages', `${lang}.json`));
}

class AppError extends Error {
  /**
   * @param {string} errorCode Canonical machine-readable error code
   * @param {Record<string, any>} [params] Interpolation parameters
   * @param {number} [status] HTTP status code
   * @param {string} [legacyCode] Optional legacy `code` field (e.g. CAPABILITY_UNAVAILABLE, BUSY, NOT_FOUND)
   */
  constructor(errorCode, params = {}, status = 400, legacyCode = undefined) {
    super(errorCode);
    this.name = 'AppError';
    this.errorCode = errorCode;
    this.params = params && typeof params === 'object' ? params : {};
    this.status = Number.isInteger(status) ? status : 400;
    if (legacyCode !== undefined) {
      this.legacyCode = legacyCode;
    }
  }
}

function interpolate(template, params) {
  if (!params || typeof params !== 'object') return template;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null) {
      return String(params[key]);
    }
    return match;
  });
}

function translateServerMessage(locale, key, params = {}) {
  const norm = normalizeLocale(locale) || 'en';
  const primary = MESSAGES[norm];
  const tpl =
    (primary && Object.prototype.hasOwnProperty.call(primary, key) && primary[key]) ||
    (MESSAGES.en && Object.prototype.hasOwnProperty.call(MESSAGES.en, key) && MESSAGES.en[key]) ||
    (MESSAGES.zh && Object.prototype.hasOwnProperty.call(MESSAGES.zh, key) && MESSAGES.zh[key]) ||
    String(key);
  return interpolate(tpl, params);
}

function getMessagesForLocale(locale) {
  const norm = normalizeLocale(locale) || 'en';
  return { ...(MESSAGES[norm] || MESSAGES.en) };
}

function getErrorCatalog(locale) {
  return {
    locale: normalizeLocale(locale) || 'en',
    supportedLocales: [...SUPPORTED_LOCALES],
    messages: getMessagesForLocale(locale)
  };
}

function sanitizeErrorMessage(err) {
  const raw = err && err.message ? String(err.message) : String(err ?? 'Unknown error');
  return raw.replace(/(?:\/[\w.@%+-]+){2,}/g, '<path>').slice(0, 300);
}

function safeLogError(err, context = '') {
  const ref = crypto.randomBytes(4).toString('hex');
  const tag = context ? `[gateway:${context}]` : '[gateway]';
  console.error(`${tag} ref=${ref}`, (err && err.stack) || err);
  return { ref, sanitized: sanitizeErrorMessage(err) };
}

module.exports = {
  AppError,
  translateServerMessage,
  getMessagesForLocale,
  getErrorCatalog,
  sanitizeErrorMessage,
  safeLogError
};
