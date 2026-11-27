/**
 * Fail-Closed 503 Locked Diagnostics Page (unreadable gateway config / permissions mismatch).
 * Prevents unsafe fallback to /setup and provides copyable ownership remediation commands.
 */

import { h, icon, clear, richText } from '../lib/dom.js';
import { initTheme, subscribeTheme } from '../lib/theme.js';
import { initI18n, subscribeLocale, t } from '../lib/i18n.js';
import { getBoot } from '../lib/api.js';
import { copyToClipboard } from '../lib/format.js';
import { createNotice, createStateDot } from '../components/pill.js';
import { showToast } from '../components/toast.js';
import { standaloneShell, standaloneHead } from '../components/standalone.js';

const FIX_CHOWN_CMD = 'chown -R 1001:1001 ./data ./workspace';

async function bootLocked() {
  initTheme();
  await initI18n();

  const root = document.getElementById('app');
  if (!root) return;

  const boot = getBoot();
  const lockedFiles = Array.isArray(boot.lockedFiles) ? boot.lockedFiles : [];

  function fileLabel(f) {
    if (typeof f === 'string') return f;
    if (f && typeof f === 'object') return `${f.path || ''}${f.code ? ` (${f.code})` : ''}`;
    return String(f);
  }

  function render() {
    document.title = t('auth', 'lockedPageTitle');

    const copyBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn btn-sm btn-ghost',
        onClick: async () => {
          const ok = await copyToClipboard(FIX_CHOWN_CMD);
          showToast(ok ? t('common', 'copied') : t('common', 'copyFailed'), ok ? 'success' : 'error');
        }
      },
      icon('copy', 14),
      h('span', { className: 'btn-label' }, t('common', 'copy'))
    );

    const shell = standaloneShell({
      onPrefsChanged: render,
      width: 'md',
      children: [
        standaloneHead({
          title: t('auth', 'lockedHeading'),
          align: 'start',
          leading: h('div', { className: 'standalone-status' },
            createStateDot({ state: 'error', text: 'HTTP 503 · Fail-Closed Protection' })
          )
        }),
        h('div', { role: 'alert' },
          createNotice({
            level: 'danger',
            title: t('auth', 'lockedReasonTitle'),
            body: richText(t('auth', 'lockedReasonBody'))
          })
        ),
        lockedFiles.length > 0
          ? h('div', { className: 'field' },
            h('div', { className: 'field-label' }, t('auth', 'lockedFilesLabel')),
            h('ul', { className: 'file-list' }, lockedFiles.map((f) => h('li', null, h('code', null, fileLabel(f)))))
          )
          : null,
        h('div', { className: 'field' },
          h('div', { className: 'field-label' }, t('auth', 'lockedFixStep1')),
          h('div', { className: 'cmd-block' },
            h('code', null, FIX_CHOWN_CMD),
            copyBtn
          ),
          h('p', { className: 'field-hint' }, richText(t('auth', 'lockedPuidHint')))
        ),
        h('div', { className: 'actions' },
          h('button', {
            type: 'button',
            className: 'btn btn-primary',
            onClick: () => window.location.reload()
          }, icon('refresh', 16), h('span', { className: 'btn-label' }, t('common', 'retry')))
        )
      ]
    });

    clear(root);
    root.appendChild(shell);
  }

  subscribeLocale(render);
  subscribeTheme(render);
  render();
}

bootLocked();
