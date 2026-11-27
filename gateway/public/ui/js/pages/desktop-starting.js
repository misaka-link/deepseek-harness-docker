/**
 * Container Desktop Starting Interstitial Page (/desktop-starting).
 * Keeps <meta http-equiv="refresh"> in sync, tracks retries via sessionStorage,
 * and surfaces Admin logs shortcut after >= 5 attempts. Visuals follow the DSH boot page
 * (wordmark · ring spinner · tertiary hint).
 */

import { h, icon, clear } from '../lib/dom.js';
import { initTheme, subscribeTheme } from '../lib/theme.js';
import { initI18n, subscribeLocale, t } from '../lib/i18n.js';
import { getBoot, getAdminPath } from '../lib/api.js';
import { createNotice } from '../components/pill.js';
import { standaloneShell, standaloneHead } from '../components/standalone.js';

async function bootDesktopStarting() {
  initTheme();
  await initI18n();

  const root = document.getElementById('app');
  if (!root) return;

  const boot = getBoot();
  const qRetry = parseInt(new URLSearchParams(window.location.search).get('retry') || '', 10);
  const retrySec = Number.isFinite(qRetry) && qRetry > 0
    ? qRetry
    : (Number(boot.retrySeconds) > 0 ? Number(boot.retrySeconds) : 3);

  const meta = document.querySelector('meta[http-equiv="refresh"]');
  if (meta) meta.setAttribute('content', String(retrySec));

  let attempts = 0;
  try {
    attempts = parseInt(sessionStorage.getItem('dsh-desktop-starting-attempts') || '0', 10) || 0;
    attempts += 1;
    sessionStorage.setItem('dsh-desktop-starting-attempts', String(attempts));
  } catch {}

  let left = retrySec;
  let countNode = null;

  function render() {
    document.title = t('desktop', 'startingPageTitle');
    countNode = h('strong', null, String(Math.max(left, 0)));

    const adminHref = `${getAdminPath()}/`;

    const shell = standaloneShell({
      onPrefsChanged: render,
      className: 'is-boot',
      children: [
        h('div', { className: 'boot', role: 'status', 'aria-live': 'polite' },
          standaloneHead({ title: t('desktop', 'startingTitle'), desc: t('desktop', 'startingSubtitle') }),
          h('div', { className: 'boot-spinner', 'aria-hidden': 'true' }),
          h('p', { className: 'boot-hint' },
            t('desktop', 'startingCountdownPrefix'), ' ', countNode, ' ', t('desktop', 'startingCountdownSuffix')
          ),
          h('button', {
            type: 'button',
            className: 'btn',
            onClick: () => window.location.reload()
          }, icon('refresh', 16), h('span', { className: 'btn-label' }, t('desktop', 'startingRefreshNow')))
        ),
        attempts >= 5
          ? createNotice({
            level: 'warn',
            body: t('desktop', 'startingSlowHint', { count: attempts }),
            actions: h('a', { href: adminHref, className: 'link-strong' }, t('desktop', 'startingGoAdminLogs'))
          })
          : null
      ],
      footer: h('span', null, t('desktop', 'startingFooter'))
    });

    clear(root);
    root.appendChild(shell);
  }

  subscribeLocale(render);
  subscribeTheme(render);
  render();

  const timer = setInterval(() => {
    left -= 1;
    if (countNode) countNode.textContent = String(Math.max(left, 0));
    if (left <= 0) {
      clearInterval(timer);
      window.location.reload();
    }
  }, 1000);
}

bootDesktopStarting();
