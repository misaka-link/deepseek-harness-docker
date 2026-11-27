/**
 * Main Admin Dashboard Application Entrypoint.
 */

import { h, clear } from '../lib/dom.js';
import { initTheme, subscribeTheme } from '../lib/theme.js';
import { initI18n, subscribeLocale, t } from '../lib/i18n.js';
import { apiJson, getAdminPath, getVncPath, isMiniVariant, guardedPoll, redirectToLogin } from '../lib/api.js';
import { renderSidebar } from '../components/sidebar.js';
import { renderTopbar } from '../components/topbar.js';
import { showToast } from '../components/toast.js';
import { openVersionHubModal } from '../modals/version-hub.js';
import { renderDshPanel, patchDshLogs } from '../panels/dsh.js';
import { renderPluginsPanel } from '../panels/plugins.js';
import { renderDesktopPanel, patchDesktopRuntime } from '../panels/desktop.js';
import { renderSnapshotsPanel } from '../panels/snapshots.js';
import { renderSettingsPanel, syncAppearanceControls } from '../panels/settings.js';

const SIDEBAR_COLLAPSE_KEY = 'dshd.sidebar.collapsed';
const AUTO_SCROLL_KEY = 'dshAdminAutoScroll';
const VALID_TABS = ['dsh', 'plugins', 'desktop', 'snapshots', 'settings'];
/** Background re-renders wait this long after the last pointer/keyboard interaction inside the panel. */
const INTERACTION_GRACE_MS = 1500;

function readBoolStorage(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === '1' || v === 'true';
  } catch {
    return fallback;
  }
}

function writeBoolStorage(key, val) {
  try {
    localStorage.setItem(key, val ? '1' : '0');
  } catch {}
}

function normalizeTabId(raw, isMini) {
  const clean = String(raw || '').trim().replace(/^#/, '').replace(/^tab-/, '');
  if (!VALID_TABS.includes(clean)) return 'dsh';
  if (isMini && clean === 'desktop') return 'dsh';
  return clean;
}

async function bootAdmin() {
  initTheme();
  await initI18n();

  const root = document.getElementById('app');
  if (!root) return;

  const adminPath = getAdminPath();
  const initialMini = isMiniVariant();

  const urlParams = new URLSearchParams(window.location.search);
  const initialTab = normalizeTabId(urlParams.get('tab') || window.location.hash, initialMini);

  const state = {
    activeTab: initialTab,
    isMini: initialMini,
    collapsed: readBoolStorage(SIDEBAR_COLLAPSE_KEY, false),
    drawerOpen: false,
    status: null,
    versionCheck: null,
    dshVersions: null,
    versionStore: null,
    rollbackPoint: null,
    dshLogs: null,
    plugins: null,
    toolCache: null,
    snapshots: null,
    snapshotJob: null,
    localSnapshotTask: '',
    switching: false,
    switchProgress: { visible: false, step: 1, total: 5, percent: 0, label: '', mode: 'install' },
    terminalLines: [],
    autoScroll: readBoolStorage(AUTO_SCROLL_KEY, true),
    selectedVersion: '',
    pluginSearch: '',
    pluginCategory: 'all',
    /** Desktop form has unsaved user edits: background polls only patch runtime indicators. */
    desktopDirty: false
  };

  let snapshotPollTimer = null;
  let snapshotPollInFlight = false;
  let snapshotPollStartedAt = 0;
  let lastInteractionAt = 0;
  let deferredRender = false;
  let lastStatusSig = '';

  // Frame skeleton DOM nodes (mounted once, slots updated smoothly)
  const sidebarSlot = h('div', { className: 'app-sidebar-col' });
  const topbarSlot = h('div', { className: 'app-topbar-slot' });
  const mainSlot = h('div', { className: 'app-page', id: 'adminMainContent' });
  const scrollEl = h('main', { className: 'app-content' }, mainSlot);
  const drawerMask = h('div', {
    className: 'drawer-mask',
    onClick: () => setDrawerOpen(false)
  });

  const frameEl = h(
    'div',
    {
      className: 'app-frame',
      dataset: { collapsed: String(state.collapsed), drawerOpen: 'false' }
    },
    sidebarSlot,
    drawerMask,
    h('div', { className: 'app-center' }, topbarSlot, scrollEl)
  );

  clear(root);
  root.appendChild(frameEl);

  // Interaction tracking: background polls never rebuild a panel the user is touching.
  const markInteraction = () => { lastInteractionAt = Date.now(); };
  mainSlot.addEventListener('pointerdown', markInteraction, true);
  mainSlot.addEventListener('keydown', markInteraction, true);
  const onFormEdit = (e) => {
    markInteraction();
    if (state.activeTab === 'desktop' && e.target instanceof Element && e.target.closest('[data-desktop-form]')) {
      state.desktopDirty = true;
    }
  };
  mainSlot.addEventListener('input', onFormEdit, true);
  mainSlot.addEventListener('change', onFormEdit, true);

  function updateDocumentTitle() {
    document.title = t('shell', 'pageTitle');
  }

  function isUserEditingForm() {
    const active = document.activeElement;
    if (!active || !mainSlot.contains(active)) return false;
    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  function recentlyInteracted() {
    return Date.now() - lastInteractionAt < INTERACTION_GRACE_MS;
  }

  function setDrawerOpen(open) {
    state.drawerOpen = Boolean(open);
    frameEl.dataset.drawerOpen = String(state.drawerOpen);
    document.body.style.overflow = state.drawerOpen ? 'hidden' : '';
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    writeBoolStorage(SIDEBAR_COLLAPSE_KEY, state.collapsed);
    frameEl.dataset.animating = 'true';
    frameEl.dataset.collapsed = String(state.collapsed);
    setTimeout(() => { delete frameEl.dataset.animating; }, 320);
    renderChrome();
  }

  function onPrefsChanged() {
    // Language changes re-render everything through subscribeLocale; theme changes only
    // touch chrome + the appearance cubes so unsaved form state is never wiped.
    renderChrome();
    if (state.activeTab === 'settings') syncAppearanceControls(mainSlot);
  }

  function renderChrome() {
    clear(sidebarSlot);
    sidebarSlot.appendChild(renderSidebar({
      activeTab: state.activeTab,
      isMini: state.isMini,
      collapsed: state.collapsed,
      status: state.status,
      versionCheck: state.versionCheck,
      vncPath: getVncPath(),
      onSelectTab: (tabId) => actions.switchTab(tabId),
      onToggleCollapse: toggleCollapse,
      onCloseDrawer: () => setDrawerOpen(false),
      onOpenVersionHub: () => actions.openVersionHub(),
      onPrefsChanged
    }));

    clear(topbarSlot);
    topbarSlot.appendChild(renderTopbar({
      activeTab: state.activeTab,
      status: state.status,
      versionCheck: state.versionCheck,
      isMini: state.isMini,
      vncPath: getVncPath(),
      onOpenDrawer: () => setDrawerOpen(true),
      onToggleCollapse: toggleCollapse,
      onOpenVersionHub: () => actions.openVersionHub()
    }));
  }

  /**
   * @param {boolean} force  true = explicit user navigation / action; false = background refresh
   *                         (skipped while a form control is focused or was just touched).
   */
  function renderMain(force = true) {
    if (!force && (isUserEditingForm() || recentlyInteracted())) {
      deferredRender = true;
      return;
    }
    deferredRender = false;
    mainSlot.dataset.panel = state.activeTab;
    if (state.activeTab === 'dsh') {
      renderDshPanel(mainSlot, ctx);
    } else if (state.activeTab === 'plugins') {
      renderPluginsPanel(mainSlot, ctx);
    } else if (state.activeTab === 'desktop') {
      renderDesktopPanel(mainSlot, ctx);
    } else if (state.activeTab === 'snapshots') {
      renderSnapshotsPanel(mainSlot, ctx);
    } else if (state.activeTab === 'settings') {
      renderSettingsPanel(mainSlot, ctx);
    }
  }

  function renderAll() {
    updateDocumentTitle();
    renderChrome();
    renderMain(true);
  }

  function stopSnapshotPolling() {
    if (snapshotPollTimer) {
      clearInterval(snapshotPollTimer);
      snapshotPollTimer = null;
    }
  }

  function startSnapshotPolling(initialJob) {
    state.snapshotJob = initialJob;
    if (state.activeTab === 'snapshots') renderMain(false);
    if (snapshotPollTimer) return;
    snapshotPollStartedAt = Date.now();
    const serverTimeout = Number(initialJob?.timeoutMs) || 0;
    const deadlineMs = serverTimeout > 0 ? serverTimeout + 5 * 60 * 1000 : 30 * 60 * 1000;

    snapshotPollTimer = setInterval(async () => {
      if (snapshotPollInFlight) return;
      snapshotPollInFlight = true;
      try {
        if (Date.now() - snapshotPollStartedAt > deadlineMs) {
          stopSnapshotPolling();
          state.snapshotJob = null;
          showToast(t('snapshots', 'toastPollTimeout'), 'warn');
          await actions.refreshSnapshots();
          return;
        }
        const r = await apiJson(`${adminPath}/api/snapshots/job`, { skipAuthRedirect: true });
        if (r.status === 401) {
          stopSnapshotPolling();
          state.snapshotJob = null;
          showToast(t('errors', 'AUTH_REQUIRED'), 'warn');
          setTimeout(redirectToLogin, 1000);
          return;
        }
        if (!r.ok) return;
        const job = r.data?.job;
        if (!job) {
          stopSnapshotPolling();
          state.snapshotJob = null;
          showToast(t('snapshots', 'toastJobLost'), 'warn');
          await actions.refreshSnapshots();
          return;
        }
        state.snapshotJob = job;
        if (job.status === 'running') {
          if (state.activeTab === 'snapshots') renderMain(false);
        } else if (job.status === 'success') {
          stopSnapshotPolling();
          state.snapshotJob = null;
          showToast(t('snapshots', 'toastCreated', { file: job.filename || '' }), 'success');
          await actions.refreshSnapshots();
        } else if (job.status === 'error') {
          stopSnapshotPolling();
          state.snapshotJob = null;
          showToast(job.error || t('errors', 'UNKNOWN'), 'error');
          await actions.refreshSnapshots();
        }
      } finally {
        snapshotPollInFlight = false;
      }
    }, 2000);
  }

  const actions = {
    render: renderAll,
    renderMain: () => renderMain(true),

    switchTab(tabId) {
      const next = normalizeTabId(tabId, state.isMini);
      state.activeTab = next;
      state.desktopDirty = false;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('tab', next);
        url.hash = '';
        window.history.replaceState(null, '', url.pathname + url.search);
      } catch {}
      renderChrome();
      renderMain(true);
      try { scrollEl.scrollTop = 0; } catch {}

      if (next === 'plugins') {
        actions.refreshPlugins();
        actions.refreshToolCache();
      } else if (next === 'snapshots') {
        actions.refreshSnapshots();
      } else if (next === 'dsh') {
        actions.refreshRollback();
        actions.refreshVersionStore();
      }
    },

    openVersionHub() {
      openVersionHubModal({
        versionCheck: state.versionCheck,
        currentDshVersion: state.status?.dsh?.version || state.dshVersions?.current || '',
        onRefresh: (force) => actions.refreshVersionCheck(force)
      });
    },

    /** Called by the desktop panel after a successful config save. */
    markDesktopClean() {
      state.desktopDirty = false;
    },

    async refreshStatus() {
      const r = await apiJson(`${adminPath}/api/status`);
      if (!r.ok || !r.data) return;
      const hadStatus = Boolean(state.status);
      let sig = '';
      try { sig = JSON.stringify(r.data); } catch { sig = String(Date.now()); }
      const changed = sig !== lastStatusSig;
      lastStatusSig = sig;
      state.status = r.data;
      if (r.data.capabilities) {
        const nowMini = isMiniVariant(r.data.capabilities);
        if (r.data.capabilities.variant) {
          document.documentElement.dataset.variant = r.data.capabilities.variant;
        }
        state.isMini = nowMini;
        if (nowMini && state.activeTab === 'desktop') {
          actions.switchTab('dsh');
          return;
        }
      }
      if (changed || !hadStatus) renderChrome();

      const tab = state.activeTab;
      if (tab === 'settings') {
        // Settings is a form: hydrate once, then never rebuild in the background.
        // It re-renders only on explicit tab switch / locale change / reset / save.
        if (!hadStatus) renderMain(true);
      } else if (tab === 'desktop') {
        if (!hadStatus) {
          renderMain(true);
        } else if (state.desktopDirty || isUserEditingForm() || recentlyInteracted()) {
          patchDesktopRuntime(mainSlot, ctx);
        } else if (changed) {
          renderMain(false);
        }
      } else if (tab === 'dsh') {
        if (!hadStatus || changed || deferredRender) renderMain(false);
      } else if (deferredRender) {
        renderMain(false);
      }
    },

    async refreshVersionCheck(force = false) {
      const r = await apiJson(`${adminPath}/api/version/check?refresh=${force ? '1' : '0'}`);
      if (!r.ok || !r.data) return null;
      let same = false;
      try { same = Boolean(state.versionCheck) && JSON.stringify(state.versionCheck) === JSON.stringify(r.data); } catch {}
      state.versionCheck = r.data;
      if (!same) {
        renderChrome();
        if (state.activeTab === 'dsh') renderMain(false);
      }
      return r.data;
    },

    async refreshDshVersions(force = false) {
      const r = await apiJson(`${adminPath}/api/dsh/versions?refresh=${force ? '1' : '0'}`);
      if (!r.ok || !r.data) return;
      state.dshVersions = r.data;
      if (state.activeTab === 'dsh') renderMain(false);
    },

    async refreshVersionStore() {
      const r = await apiJson(`${adminPath}/api/dsh/versions/stats`);
      if (!r.ok || !r.data) return;
      state.versionStore = r.data;
      if (state.activeTab === 'dsh') renderMain(false);
    },

    async refreshRollback() {
      const r = await apiJson(`${adminPath}/api/dsh/rollback`);
      if (!r.ok || !r.data) return;
      state.rollbackPoint = r.data;
      if (state.activeTab === 'dsh') renderMain(false);
    },

    async refreshLogs(force = false) {
      if (state.switching && !force) return;
      const r = await apiJson(`${adminPath}/api/dsh/logs?lines=150`);
      if (!r.ok || !r.data) return;
      state.dshLogs = r.data;
      if (state.activeTab === 'dsh') {
        patchDshLogs(mainSlot, ctx);
      }
    },

    async refreshPlugins() {
      const r = await apiJson(`${adminPath}/api/plugins`);
      if (!r.ok || !r.data) return;
      state.plugins = r.data.plugins || [];
      if (state.activeTab === 'plugins') renderMain(false);
    },

    async refreshToolCache() {
      const r = await apiJson(`${adminPath}/api/maintenance/npx-cache`);
      if (!r.ok || !r.data) return;
      state.toolCache = r.data.status || null;
      if (state.activeTab === 'plugins') renderMain(false);
    },

    async refreshSnapshots() {
      const r = await apiJson(`${adminPath}/api/snapshots`);
      if (!r.ok || !r.data) return;
      state.snapshots = r.data;
      if (r.data.job && r.data.job.status === 'running') {
        startSnapshotPolling(r.data.job);
      }
      if (state.activeTab === 'snapshots' || state.activeTab === 'dsh') {
        renderMain(false);
      }
    },

    startSnapshotPolling,
    stopSnapshotPolling,

    setAutoScroll(val) {
      state.autoScroll = Boolean(val);
      writeBoolStorage(AUTO_SCROLL_KEY, state.autoScroll);
    },

    appendTerminalLine(line) {
      state.terminalLines.push(String(line));
      if (state.terminalLines.length > 500) {
        state.terminalLines = state.terminalLines.slice(-400);
      }
      if (state.activeTab === 'dsh') {
        patchDshLogs(mainSlot, ctx);
      }
    },

    clearTerminal() {
      state.terminalLines = [];
      if (state.activeTab === 'dsh') {
        patchDshLogs(mainSlot, ctx);
      }
    },

    setSwitchProgress(prog) {
      state.switchProgress = prog;
      if (state.activeTab === 'dsh') {
        renderMain(true);
      }
    },

    setSwitching(val) {
      state.switching = Boolean(val);
      if (!state.switching) {
        state.terminalLines = [];
      }
      if (state.activeTab === 'dsh') {
        renderMain(true);
      }
    }
  };

  const ctx = {
    adminPath,
    vncPath: getVncPath(),
    state,
    actions
  };

  // Escape closes mobile drawer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.drawerOpen) {
      setDrawerOpen(false);
    }
  });

  window.addEventListener('beforeunload', () => {
    stopSnapshotPolling();
  });

  // Live instant re-render on language changes; theme changes only touch chrome.
  subscribeLocale(() => renderAll());
  subscribeTheme(() => {
    renderChrome();
    if (state.activeTab === 'settings') syncAppearanceControls(mainSlot);
  });

  // Initial render & parallel data hydration
  renderAll();

  const pollStatus = guardedPoll(() => actions.refreshStatus());
  const pollVersionCheck = guardedPoll(() => actions.refreshVersionCheck(false));
  const pollLogs = guardedPoll(() => actions.refreshLogs(false));

  Promise.allSettled([
    pollStatus(),
    actions.refreshDshVersions(false),
    actions.refreshVersionStore(),
    actions.refreshRollback(),
    actions.refreshSnapshots(),
    actions.refreshPlugins(),
    actions.refreshToolCache(),
    pollVersionCheck(),
    pollLogs()
  ]);

  setInterval(pollStatus, 8000);
  setInterval(pollVersionCheck, 60000);
  setInterval(pollLogs, 3000);
}

bootAdmin();
