'use strict';

/**
 * First-run setup gate and password strength policy.
 * Keeps minimum length >= 6 and common weak-password blacklist for compatibility.
 */

const session = require('./session');
const { AppError } = require('../i18n/errors');

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 256;

const WEAK_PASSWORDS = new Set([
  'admin', 'administrator', 'password', 'passw0rd', '123456', '12345678', '123456789',
  '1234567890', 'qwertyuiop', '111111', '11111111', '000000', '00000000', '888888', '88888888',
  '666666', 'deepseek', 'admin123', 'root', 'letmein', 'changeme'
]);

function isSetupRequired() {
  return !session.isAuthEnabled();
}

function isBlacklistedPassword(pwd) {
  if (typeof pwd !== 'string') return false;
  return WEAK_PASSWORDS.has(pwd.trim().toLowerCase());
}

function isWeakPassword(pwd) {
  if (typeof pwd !== 'string') return true;
  const p = pwd.trim();
  if (p.length < MIN_PASSWORD_LENGTH || p.length > MAX_PASSWORD_LENGTH) return true;
  return WEAK_PASSWORDS.has(p.toLowerCase());
}

function validatePasswordStrength(pwd) {
  if (typeof pwd !== 'string' || !pwd.trim()) {
    throw new AppError('SETUP_PASSWORD_WEAK', { minLength: MIN_PASSWORD_LENGTH }, 400);
  }
  const trimmed = pwd.trim();
  if (WEAK_PASSWORDS.has(trimmed.toLowerCase())) {
    throw new AppError('SETUP_PASSWORD_BLACKLISTED', {}, 400);
  }
  if (trimmed.length < MIN_PASSWORD_LENGTH || trimmed.length > MAX_PASSWORD_LENGTH) {
    throw new AppError('SETUP_PASSWORD_WEAK', { minLength: MIN_PASSWORD_LENGTH }, 400);
  }
  return trimmed;
}

function validateSetupPassword(pwd, confirm) {
  if (typeof pwd !== 'string' || typeof confirm !== 'string' || !pwd || !confirm) {
    throw new AppError('SETUP_PASSWORD_REQUIRED', {}, 400);
  }
  if (pwd !== confirm) {
    throw new AppError('SETUP_PASSWORD_MISMATCH', {}, 400);
  }
  validatePasswordStrength(pwd);
  return pwd;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  WEAK_PASSWORDS,
  isSetupRequired,
  isBlacklistedPassword,
  isWeakPassword,
  validatePasswordStrength,
  validateSetupPassword
};
