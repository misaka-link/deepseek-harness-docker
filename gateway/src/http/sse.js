'use strict';

/**
 * Unified Server-Sent Events (SSE) helper with localized progress/log frames
 * and reverse-proxy buffering disabled (X-Accel-Buffering: no).
 */

const { negotiateLocale } = require('../i18n/negotiate');
const { translateServerMessage } = require('../i18n/errors');

function openSse(res, req) {
  const locale = negotiateLocale(req);
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
  }

  function send(data) {
    if (!res || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }

  function progress(prog = {}) {
    const frame = { type: 'progress', ...prog };
    if (prog.labelKey && !prog.label) {
      frame.label = translateServerMessage(locale, prog.labelKey, prog.params || {});
    }
    send(frame);
  }

  function log(msgOrKey, params) {
    if (typeof msgOrKey === 'string' && msgOrKey.startsWith('sse.')) {
      const message = translateServerMessage(locale, msgOrKey, params || {});
      send({
        type: 'log',
        msgKey: msgOrKey,
        params: params || {},
        message
      });
      return;
    }
    send({ type: 'log', message: String(msgOrKey ?? '') });
  }

  function done(payload = {}) {
    send({ type: 'done', ...payload });
    end();
  }

  function end() {
    if (!res || res.writableEnded) return;
    try {
      res.end();
    } catch {}
  }

  return {
    locale,
    send,
    progress,
    log,
    done,
    end
  };
}

module.exports = { openSse };
