'use strict';

/**
 * Request body parsers with strict byte limits and typed AppError failures.
 * Invalid JSON throws 400 REQ_INVALID_JSON; oversized body throws 413 REQ_BODY_TOO_LARGE.
 */

const { AppError } = require('../i18n/errors');

const DEFAULT_MAX_JSON_BYTES = 512 * 1024; // 512 KB

function readRawBody(req, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_JSON_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        fail(new AppError('REQ_BODY_TOO_LARGE', { maxKB: Math.max(1, Math.round(maxBytes / 1024)) }, 413));
        try {
          req.resume();
        } catch {}
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      fail(err);
    });
  });
}

async function readJsonBody(req, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_JSON_BYTES;
  const allowEmpty = opts.allowEmpty !== false;
  const raw = await readRawBody(req, { maxBytes });
  const trimmed = raw.trim();
  if (!trimmed) {
    if (allowEmpty) return {};
    throw new AppError('REQ_INVALID_JSON', {}, 400);
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed === null || typeof parsed !== 'object' ? {} : parsed;
  } catch {
    throw new AppError('REQ_INVALID_JSON', {}, 400);
  }
}

module.exports = {
  DEFAULT_MAX_JSON_BYTES,
  readRawBody,
  readJsonBody
};
