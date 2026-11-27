'use strict';

/**
 * Unauthenticated read-only UI preferences endpoint: GET /__ui/prefs.
 * Exposes DSH locale/theme preferences and negotiated effective settings (no secrets).
 */

const { getUiPrefsSnapshot } = require('../i18n/negotiate');
const { sendJson } = require('../http/respond');

function handleUiPrefs(req, res) {
  const snap = getUiPrefsSnapshot(req);
  return sendJson(res, 200, {
    ok: true,
    dsh: snap.dsh,
    effective: {
      lang: snap.effective.lang,
      langTag: snap.effective.langTag,
      themePref: snap.effective.themePref
    },
    supportedLocales: snap.supportedLocales
  });
}

module.exports = { handleUiPrefs };
