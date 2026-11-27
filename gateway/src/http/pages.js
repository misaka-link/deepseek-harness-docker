'use strict';

/**
 * HTML template renderer with zero-FOUC theme/locale boot injection
 * and localized fallback HTML error/status pages.
 */

const fs = require('fs');
const path = require('path');
const CAPABILITIES = require('../core/capabilities');
const { resolveProjectVersion } = require('../core/project-version');
const { getUiPrefsSnapshot, negotiateLocale } = require('../i18n/negotiate');
const { translateServerMessage } = require('../i18n/errors');
const { getUiRev } = require('./static');
const { sendHtml } = require('./respond');

const TEMPLATES_DIR = path.resolve(__dirname, '../../public/templates');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * First-paint style tag aligned with DSH boot-theme semantics.
 * Prevents white flash in dark mode and dark flash in light mode.
 */
function buildBootStyle(themePref) {
  if (themePref === 'dark') {
    return '<style id="dshd-boot-theme">html,body{background-color:#151517;color:#f5f5f7;color-scheme:dark;}</style>';
  }
  if (themePref === 'light') {
    return '<style id="dshd-boot-theme">html,body{background-color:#ffffff;color:#0f1115;color-scheme:light;}</style>';
  }
  return '<style id="dshd-boot-theme">html,body{background-color:#ffffff;color:#0f1115;color-scheme:light dark;}@media(prefers-color-scheme:dark){html,body{background-color:#151517;color:#f5f5f7;}}</style>';
}

/**
 * Inline script placed at the top of <body> to toggle data-ds-dark-theme before first paint.
 */
function buildBootBodyScript(themePref) {
  const prefLiteral = JSON.stringify(themePref || 'system');
  return `<script>(function(){try{var p=${prefLiteral};var d=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(document.body){document.body.toggleAttribute("data-ds-dark-theme",!!d);}document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();</script>`;
}

function buildBootData(req, extraBoot = {}, runtimeConfig = {}, capabilities = CAPABILITIES) {
  const snap = getUiPrefsSnapshot(req);
  const adminPath = runtimeConfig.adminPath || '/admin';
  const vncPathHref = runtimeConfig.vncPathHref || '/vnc/';
  const rev = getUiRev();

  return {
    lang: snap.effective.lang,
    langTag: snap.effective.langTag,
    langCookie: snap.cookie.lang,
    themePref: snap.effective.themePref,
    themeCookie: snap.cookie.theme,
    dshPrefs: {
      locale: snap.dsh.locale,
      theme: snap.dsh.theme
    },
    adminPath,
    vncPath: capabilities.vnc.supported ? vncPathHref : null,
    variant: capabilities.variant,
    capabilities,
    rev,
    projectVersion: resolveProjectVersion(),
    retrySeconds: 3,
    lockedFiles: [],
    ...extraBoot
  };
}

function renderFallbackTemplateHtml(templateName, boot, req) {
  const lang = boot.lang;
  const t = (key, params) => translateServerMessage(lang, key, params);
  const bootStyle = buildBootStyle(boot.themePref);
  const bootBodyScript = buildBootBodyScript(boot.themePref);
  const bootJson = safeJsonForScript(boot);
  const adminHref = escapeHtml(boot.adminPath + '/');

  let title = 'DeepSeek Harness';
  let bodyContent = '';
  let extraHead = '';

  if (templateName === 'locked') {
    title = t('page.locked.title');
    const filesList = (boot.lockedFiles || [])
      .map((f) => {
        const label = typeof f === 'string' ? f : `${f.path} (${f.code || 'UNREADABLE'})`;
        return `<li><code>${escapeHtml(label)}</code></li>`;
      })
      .join('');
    bodyContent = `<main class="card"><h1>${escapeHtml(t('page.locked.heading'))}</h1><p>${escapeHtml(t('page.locked.body'))}</p>${filesList ? `<ul>${filesList}</ul>` : ''}<p class="hint">${escapeHtml(t('page.locked.hint'))}</p></main>`;
  } else if (templateName === 'desktop-starting') {
    const seconds = Number(boot.retrySeconds) > 0 ? Number(boot.retrySeconds) : 3;
    title = t('page.desktopStarting.title');
    extraHead = `<meta http-equiv="refresh" content="${seconds}">`;
    bodyContent = `<main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(t('page.desktopStarting.body', { seconds }))}</p><a class="btn" href="${adminHref}">${escapeHtml(t('page.capabilityGone.action'))}</a></main>`;
  } else {
    bodyContent = `<main class="card"><h1>DeepSeek Harness</h1><p>UI template (${escapeHtml(templateName)}) is loading.</p><a class="btn" href="${adminHref}">${escapeHtml(t('page.capabilityGone.action'))}</a></main>`;
  }

  return `<!DOCTYPE html>
<html lang="${escapeHtml(boot.langTag)}" data-variant="${escapeHtml(boot.variant)}" data-ds-theme-source="${escapeHtml(boot.themePref)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extraHead}
<title>${escapeHtml(title)}</title>
${bootStyle}
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;box-sizing:border-box}
  .card{max-width:560px;width:100%;padding:28px 32px;border-radius:16px;border:1px solid rgba(128,128,128,.25);background:rgba(128,128,128,.06)}
  h1{margin:0 0 12px;font-size:18px}
  p{margin:0 0 14px;font-size:14px;line-height:1.65;opacity:.85}
  ul{margin:0 0 16px;padding-left:20px;font-size:13px;line-height:1.7}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .hint{font-size:13px;opacity:.75}
  .btn{display:inline-block;padding:8px 16px;border-radius:8px;background:#4176e6;color:#fff;text-decoration:none;font-size:13px;font-weight:500}
</style>
<script>window.__DSHD_BOOT__=${bootJson};</script>
</head>
<body>${bootBodyScript}${bodyContent}</body>
</html>`;
}

/**
 * Render an HTML template from gateway/public/templates/<templateName>.html
 * with all boot placeholders replaced. Falls back to safe inline HTML if missing.
 */
function renderTemplate(req, res, templateName, extraBoot = {}, statusCode = 200, ctx = {}) {
  const runtimeConfig = ctx.runtimeConfig || {};
  const capabilities = ctx.capabilities || CAPABILITIES;
  const boot = buildBootData(req, extraBoot, runtimeConfig, capabilities);
  const bootStyle = buildBootStyle(boot.themePref);
  const bootBodyScript = buildBootBodyScript(boot.themePref);
  const bootJson = safeJsonForScript(boot);

  const tplPath = path.join(TEMPLATES_DIR, `${templateName}.html`);
  let html = null;
  try {
    if (fs.existsSync(tplPath)) {
      const raw = fs.readFileSync(tplPath, 'utf8');
      const replacements = {
        '{{LANG_TAG}}': boot.langTag,
        '{{LANG}}': boot.lang,
        '{{VARIANT}}': boot.variant,
        '{{THEME_SOURCE}}': boot.themePref,
        '{{UI_REV}}': boot.rev,
        '{{ADMIN_PATH}}': boot.adminPath,
        '{{BOOT_STYLE}}': bootStyle,
        '{{BOOT_BODY_SCRIPT}}': bootBodyScript,
        '{{BOOT_JSON}}': bootJson
      };
      html = raw.replace(
        /\{\{(LANG_TAG|LANG|VARIANT|THEME_SOURCE|UI_REV|ADMIN_PATH|BOOT_STYLE|BOOT_BODY_SCRIPT|BOOT_JSON)\}\}/g,
        (token) => replacements[token]
      );
    }
  } catch (err) {
    console.warn(`[pages] 读取模板失败 (${templateName}):`, err.message);
  }

  if (!html) {
    html = renderFallbackTemplateHtml(templateName, boot, req);
  }

  return sendHtml(res, statusCode, html);
}

function renderStatusCardHtml(req, { title, heading, body, extraLine = '', actionHref, actionLabel, refreshSeconds = 0, accentColor = '#4176e6' }) {
  const snap = getUiPrefsSnapshot(req);
  const bootStyle = buildBootStyle(snap.effective.themePref);
  const bootBodyScript = buildBootBodyScript(snap.effective.themePref);
  const refreshTag = refreshSeconds > 0 ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(snap.effective.langTag)}" data-ds-theme-source="${escapeHtml(snap.effective.themePref)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshTag}
<title>${escapeHtml(title)}</title>
${bootStyle}
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:520px;width:100%;padding:32px 36px;border-radius:16px;border:1px solid rgba(128,128,128,.24);background:rgba(128,128,128,.06);text-align:center}
  h1{font-size:18px;margin:0 0 12px;color:${accentColor}}
  p{font-size:13px;line-height:1.75;opacity:.85;margin:0 0 20px}
  a.btn{display:inline-block;padding:9px 18px;border-radius:8px;background:${accentColor};color:#fff;text-decoration:none;font-size:13px;font-weight:500}
</style>
</head>
<body>${bootBodyScript}<div class="box">
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(body)}${extraLine ? '<br>' + escapeHtml(extraLine) : ''}</p>
  ${actionHref ? `<a class="btn" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>` : ''}
</div></body></html>`;
}

function renderCapabilityGonePage(req, res, runtimeConfig = {}) {
  const locale = negotiateLocale(req);
  const adminPath = runtimeConfig.adminPath || '/admin';
  const html = renderStatusCardHtml(req, {
    title: translateServerMessage(locale, 'page.capabilityGone.title'),
    heading: translateServerMessage(locale, 'page.capabilityGone.heading'),
    body: translateServerMessage(locale, 'page.capabilityGone.body'),
    actionHref: adminPath + '/',
    actionLabel: translateServerMessage(locale, 'page.capabilityGone.action')
  });
  return sendHtml(res, 404, html);
}

function renderDesktopDisabledPage(req, res, runtimeConfig = {}) {
  const locale = negotiateLocale(req);
  const adminPath = runtimeConfig.adminPath || '/admin';
  const html = renderStatusCardHtml(req, {
    title: translateServerMessage(locale, 'page.desktopDisabled.title'),
    heading: translateServerMessage(locale, 'page.desktopDisabled.heading'),
    body: translateServerMessage(locale, 'page.desktopDisabled.body'),
    actionHref: adminPath + '/',
    actionLabel: translateServerMessage(locale, 'page.desktopDisabled.action')
  });
  return sendHtml(res, 503, html);
}

function renderDesktopStartingPage(req, res, runtimeConfig = {}, opts = {}) {
  const retrySeconds = Number(opts.retrySeconds) > 0 ? Number(opts.retrySeconds) : 3;
  return renderTemplate(req, res, 'desktop-starting', { retrySeconds }, 200, { runtimeConfig });
}

function renderLockedPage(req, res, runtimeConfig = {}, configState = {}) {
  const files = Array.isArray(configState.files) ? configState.files : [];
  return renderTemplate(
    req,
    res,
    'locked',
    {
      lockedFiles: files,
      lockedReason: configState.reason || ''
    },
    503,
    { runtimeConfig }
  );
}

function renderUpstreamTimeoutPage(req, res, runtimeConfig = {}) {
  const locale = negotiateLocale(req);
  const adminPath = runtimeConfig.adminPath || '/admin';
  const seconds = Math.round((runtimeConfig.proxyTimeoutMs || 30000) / 1000);
  const html = renderStatusCardHtml(req, {
    title: translateServerMessage(locale, 'page.upstreamTimeout.title'),
    heading: translateServerMessage(locale, 'page.upstreamTimeout.heading'),
    body: translateServerMessage(locale, 'page.upstreamTimeout.body', { seconds }),
    actionHref: adminPath + '/',
    actionLabel: translateServerMessage(locale, 'page.upstreamTimeout.action'),
    refreshSeconds: 5,
    accentColor: '#b45309'
  });
  return sendHtml(res, 504, html, { 'Retry-After': '5' });
}

function renderUpstreamBadGatewayPage(req, res, runtimeConfig = {}, dshManager = null) {
  const locale = negotiateLocale(req);
  const adminPath = runtimeConfig.adminPath || '/admin';
  let body;
  if (dshManager && dshManager.manualStopped) {
    body = translateServerMessage(locale, 'UPSTREAM_STOPPED');
  } else if (dshManager && dshManager.lastExitInfo && !dshManager.proc) {
    body = translateServerMessage(locale, 'UPSTREAM_EXITED', {
      code: dshManager.lastExitInfo.code ?? -1
    });
  } else {
    body = translateServerMessage(locale, 'UPSTREAM_STARTING');
  }

  const html = renderStatusCardHtml(req, {
    title: translateServerMessage(locale, 'page.upstreamBadGateway.title'),
    heading: translateServerMessage(locale, 'page.upstreamBadGateway.heading'),
    body,
    extraLine: translateServerMessage(locale, 'page.upstreamBadGateway.refresh'),
    actionHref: adminPath + '/',
    actionLabel: translateServerMessage(locale, 'page.upstreamBadGateway.action'),
    refreshSeconds: 5
  });
  return sendHtml(res, 502, html);
}

module.exports = {
  TEMPLATES_DIR,
  escapeHtml,
  safeJsonForScript,
  buildBootStyle,
  buildBootBodyScript,
  buildBootData,
  renderTemplate,
  renderCapabilityGonePage,
  renderDesktopDisabledPage,
  renderDesktopStartingPage,
  renderLockedPage,
  renderUpstreamTimeoutPage,
  renderUpstreamBadGatewayPage
};
