window.__ModuleLoader__.load({
  id: '@dsh-custom/dsh-deepseek-remote-login',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');

    const zh = typeof window !== 'undefined' && window.navigator && String(window.navigator.language || '').toLowerCase().startsWith('zh');
    const L = {
      section: zh ? 'DeepSeek 登录（远程）' : 'DeepSeek Sign-in (Remote)',
      title: zh ? 'DeepSeek 账号登录' : 'DeepSeek account sign-in',
      badge: zh ? '内置容器套件组件' : 'Builtin Suite Component',
      desc: zh
        ? '远程/反向代理访问时，DeepSeek 平台只接受 localhost 回调。可复制或手动打开登录链接；登录完成后把浏览器地址栏里的回调链接粘贴到下方即可完成登录。'
        : 'When accessed remotely or behind a reverse proxy, DeepSeek only accepts a localhost callback. Copy or manually open the sign-in link; after signing in, paste the callback link from the browser address bar below.',
      status: zh ? '登录状态' : 'Status',
      idle: zh ? '未登录' : 'Signed out',
      starting: zh ? '正在获取登录链接…' : 'Requesting sign-in link…',
      waiting: zh ? '等待登录' : 'Waiting for sign in',
      getLink: zh ? '获取登录链接' : 'Get sign-in link',
      open: zh ? '打开登录链接' : 'Open sign-in link',
      copy: zh ? '复制登录链接' : 'Copy sign-in link',
      copied: zh ? '已复制 ✓' : 'Copied ✓',
      linkLabel: zh ? '登录链接' : 'Sign-in link',
      cbLabel: zh ? '回调链接' : 'Callback link',
      cbPlaceholder: zh ? '把地址栏里的 http://localhost:.../oauth/callback?code=...&state=... 整段粘贴到这里' : 'Paste the whole http://localhost:.../oauth/callback?code=...&state=... link here',
      submit: zh ? '完成登录' : 'Finish sign-in',
      submitting: zh ? '提交中…' : 'Submitting…',
      close: zh ? '关闭' : 'Close',
      cancel: zh ? '取消' : 'Cancel',
      retry: zh ? '重新获取' : 'Retry',
      emptyLink: zh ? '请先粘贴回调链接' : 'Please paste the callback link first',
      okMsg: zh ? '回调已送达 DSH，正在确认登录状态…' : 'Callback delivered to DSH; confirming the sign-in state…',
      noAuto: zh ? '已关闭自动跳转：请点击「打开登录链接」或复制后手动打开。' : 'Auto-open is disabled: click "Open sign-in link" or copy it and open manually.',
      signedInLabel: zh ? '已登录' : 'Signed in',
      accountLine: zh ? '账号' : 'Account',
      nicknameLine: zh ? '昵称' : 'Nickname',
      signedInHint: zh ? '当前环境已登录 DeepSeek 账号，无需再次登录。' : 'This environment is already signed in to DeepSeek; no further sign-in is needed.',
      recheck: zh ? '重新检测' : 'Re-check',
      checking: zh ? '检测中…' : 'Checking…',
      // 偏好设置
      prefsTitle: zh ? '显示与隐私' : 'Display & privacy',
      blurDefault: zh ? '默认模糊敏感信息（手机号 / 邮箱）' : 'Blur sensitive info by default (phone / email)',
      blurDefaultHint: zh ? '开启后页面中的手机号、邮箱会自动打码；双击任意手机号可随时模糊 / 还原。' : 'When on, phone numbers and emails on the page are masked automatically; double-click any phone number to blur or restore it.',
      nickLabel: zh ? '自定义显示昵称' : 'Custom display name',
      nickPlaceholder: zh ? '留空则显示真实账号（如 186******50）' : 'Leave empty to show the real account (e.g. 186******50)',
      nickHint: zh ? '设置后，页面中所有显示该手机号的位置（含左下角账号栏）都会改为显示昵称。' : 'Once set, every place that shows this phone number (including the bottom-left account bar) displays the nickname instead.',
      save: zh ? '保存' : 'Save',
      saved: zh ? '已保存 ✓' : 'Saved ✓',
      reset: zh ? '恢复默认' : 'Reset',
      blurHint: zh ? '提示：双击页面中任意位置的手机号即可模糊 / 还原（便于截图留档）。' : 'Tip: double-click any phone number on the page to blur or restore it (useful before taking screenshots).',
    };

    const STYLE_ID = 'dsh-deepseek-remote-login-css';
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = [
        '.dshdlq-card{background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l3,#e2e8f0);border-radius:12px;padding:20px 24px;color:var(--dsw-alias-label-primary,#0f172a);font-size:13px;line-height:1.7}',
        '.dshdlq-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}',
        '.dshdlq-title{font-size:15px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px}',
        '.dshdlq-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--dsw-alias-state-business-tertiary,#e0f2fe);color:var(--dsw-alias-state-business-primary,#0284c7)}',
        '.dshdlq-desc{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#64748b);font-size:12px}',
        '.dshdlq-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}',
        '.dshdlq-btn{box-sizing:border-box;height:34px;padding:0 16px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#e2e8f0);background:0 0;color:var(--dsw-alias-label-primary,#0f172a);font-size:13px;cursor:pointer}',
        '.dshdlq-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.05))}',
        '.dshdlq-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.dshdlq-primary{background:var(--dsw-alias-button-primary-fill,#111827);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}',
        '.dshdlq-primary:hover{background:var(--dsw-alias-button-primary-hover,#374151)}',
        '.dshdlq-input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,#e2e8f0);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f172a);font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}',
        '.dshdlq-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px}',
        '.dshdlq-dialog{box-sizing:border-box;width:100%;max-width:560px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l3,#e2e8f0);border-radius:14px;padding:22px 24px;box-shadow:0 18px 50px rgba(15,23,42,.28);color:var(--dsw-alias-label-primary,#0f172a)}',
        '.dshdlq-msg{margin-top:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b);word-break:break-all}',
        '.dshdlq-ok{color:var(--dsw-alias-state-success-primary,#15803d)}',
        '.dshdlq-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.dshdlq-label{display:block;margin:14px 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#64748b)}',
        '.dshdlq-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-1,#f1f5f9)}',
        '.dshdlq-sep{margin:18px 0 0;border-top:1px solid var(--dsw-alias-border-l3,#e2e8f0)}',
        '.dshdlq-check{display:flex;align-items:flex-start;gap:8px;margin-top:8px;font-size:12px;color:var(--dsw-alias-label-primary,#0f172a);cursor:pointer;line-height:1.6}',
        '.dshdlq-check input{margin:3px 0 0;cursor:pointer}',
        '.dshdlq-blur{filter:blur(5px);transition:filter .12s ease;cursor:pointer;-webkit-user-select:none;user-select:none}',
        '.dshdlq-hint{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8)}',
      ].join('\n');
      document.head.appendChild(el);
    }

    // ── 状态 ─────────────────────────────────────────────────────
    let pluginCtx = null;
    let accountState = null;   // 来自 watch 流（可能一直不可用）
    let signedIn = false;      // 登录状态判定结果
    let profile = null;        // { id, avatarUrl, name, contact }
    let checked = false;
    let ui = { open: false, link: '', input: '', msg: '', msgKind: '', busy: false, copied: false, saved: false };
    const subs = new Set();
    const notify = () => { for (const f of [...subs]) { try { f(); } catch (e) {} } };
    const setUi = (patch) => { ui = Object.assign({}, ui, patch); notify(); };

    // ── 偏好设置（localStorage，按浏览器保存）────────────────────
    const PREFS_KEY = 'dsh-deepseek-remote-login:prefs';
    let prefs = { blurByDefault: false, nickname: '' };
    function loadPrefs() {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
        if (raw) prefs = Object.assign({}, prefs, JSON.parse(raw));
      } catch (e) {}
      return prefs;
    }
    function setPref(key, value) {
      prefs = Object.assign({}, prefs, { [key]: value });
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
      if (key === 'blurByDefault') { if (value) autoBlurScan(); else clearAutoBlur(); }
      watchDomForAutoBlur();   // 开启任一功能后补挂观察器
      refreshSensitive();      // 昵称改动：重写页面中的手机号显示；同时重新评估自动模糊
      notify();
    }

    function accountApi(ctx) {
      if (!ctx) return null;
      try { if (ctx.remote && ctx.remote.account) return ctx.remote.account; } catch (e) {}
      try { const a = typeof ctx.get === 'function' ? ctx.get('remote.account') : null; if (a) return a; } catch (e) {}
      return null;
    }
    function isActiveAttempt(state) {
      const a = state && state.attempt;
      if (!a) return false;
      return ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(String(a.phase));
    }

    let cachedVersion = '';
    async function resolveClientVersion() {
      if (cachedVersion) return cachedVersion;
      try {
        const r = await fetch('/__api/account/client-version', { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const j = await r.json();
          if (j && j.version) { cachedVersion = String(j.version); return cachedVersion; }
        }
      } catch (e) {}
      cachedVersion = '0.2.1-alpha.3';
      return cachedVersion;
    }
    function activeLocale(ctx) {
      try {
        const snap = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null;
        if (snap && snap.active) return snap.active;
      } catch (e) {}
      return zh ? 'zh-CN' : 'en-US';
    }
    async function clientMeta() {
      return { version: await resolveClientVersion(), locale: activeLocale(pluginCtx), timezoneOffsetSeconds: -(new Date()).getTimezoneOffset() * 60 };
    }

    async function fetchProfile() {
      const api = accountApi(pluginCtx);
      if (!api || typeof api.getProfile !== 'function') return null;
      try {
        const res = await api.getProfile(await clientMeta());
        const v = res && res.ok ? res.value : null;
        if (v && v.status === 'ready' && v.value) return v.value;
      } catch (e) {}
      return null;
    }
    // 账号展示文本：设置了自定义昵称则只显示昵称（不泄露真实账号）
    function displayAccount() {
      if (prefs.nickname) return prefs.nickname;
      return profile ? [profile.name, profile.contact].filter(Boolean).join(' · ') : '';
    }
    const showingNickname = () => !!prefs.nickname;

    async function fetchAccountStatus() {
      try {
        const r = await fetch('/__api/account/status', { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const j = await r.json();
          if (typeof j.signedIn === 'boolean') return j.signedIn;
        }
      } catch (e) {}
      return null;
    }
    // 登录状态检测：网关本地凭据 > watch 流 > 账号资料可读
    async function detectAccount() {
      if (!accountApi(pluginCtx)) return;
      const local = await fetchAccountStatus();
      let p = null;
      try { p = await fetchProfile(); } catch (e) {}
      if (p) profile = p;
      if (local !== null) signedIn = local;
      else if (accountState) signedIn = accountState.status === 'credential-stored';
      else signedIn = !!p;
      checked = true;
      notify();
      refreshSensitive();
    }
    function recheck() {
      checked = false; signedIn = false;
      setUi({ busy: false, msg: '', msgKind: '' });
      detectAccount();
    }
    const isSignedIn = () => signedIn === true;

    let streamStarted = false;
    function startAccountStream(ctx) {
      if (streamStarted || !ctx || !ctx.remote || typeof ctx.remote.$stream !== 'function') return;
      const api = accountApi(ctx);
      if (!api || typeof api.watch !== 'function') return;
      streamStarted = true;
      try {
        const stream = ctx.remote.$stream({
          name: 'account',
          open: (signal) => api.watch(signal),
          ended: () => new Error('account stream ended')
        });
        (async () => {
          try {
            for await (const state of stream) {
              accountState = state;
              const a = state && state.attempt;
              if (state && state.status === 'credential-stored') {
                signedIn = true; checked = true;
                if (!profile) { fetchProfile().then((p) => { if (p) profile = p; notify(); }); }
                setUi({ busy: false, link: '', input: '', msg: '', msgKind: '', copied: false });
              } else if (isActiveAttempt(state)) {
                signedIn = false; checked = true;
                setUi({ open: true, link: a && a.authorizeUrl ? String(a.authorizeUrl) : ui.link, busy: false });
              }
            }
          } catch (e) {}
        })();
      } catch (e) { streamStarted = false; }
    }
    function ensureAccount() {
      startAccountStream(pluginCtx);
      if (!checked) detectAccount();
      refreshSensitive();
    }

    function useUi() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const f = () => force((n) => n + 1);
        subs.add(f);
        return () => { subs.delete(f); };
      }, []);
      return ui;
    }
    const useMount = (fn) => React.useEffect(() => { fn(); }, []);

    async function submitCallbackLink(link) {
      const r = await fetch('/account/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link })
      });
      let j = {};
      try { j = await r.json(); } catch (e) {}
      return { status: r.status, body: j };
    }

    async function beginSignIn() {
      if (isSignedIn()) { setUi({ open: true, busy: false, msg: '', msgKind: '' }); return; }
      setUi({ busy: true, msg: '', msgKind: '', copied: false, open: true });
      const api = accountApi(pluginCtx);
      if (!api || typeof api.startSignIn !== 'function') {
        setUi({ busy: false, msgKind: 'err', msg: zh
          ? '当前 DSH 未暴露账号服务接口：请在「设置 → 模型 → DeepSeek 账号」触发登录，再回到此处粘贴回调链接完成登录。'
          : 'This DSH build does not expose the account service: trigger sign-in under Settings → Models → DeepSeek account, then paste the callback link here.' });
        return;
      }
      try {
        const meta = await clientMeta();
        const callStart = () => api.startSignIn(meta, window.location.origin, 'web');
        const pick = (r) => {
          const s = r && r.ok ? r.value : null;
          const a = s && s.attempt ? s.attempt : null;
          return { url: a && a.authorizeUrl ? String(a.authorizeUrl) : '', phase: a && a.phase ? String(a.phase) : '', status: s && s.status ? String(s.status) : '' };
        };
        let picked = pick(await callStart());
        for (let i = 0; !picked.url && i < 12; i++) {
          if (picked.status === 'credential-stored') break;
          if (picked.phase === 'failed' || picked.phase === 'expired') break;
          await new Promise((r) => setTimeout(r, 900));
          picked = pick(await callStart());
        }
        if (picked.status === 'credential-stored') { signedIn = true; checked = true; setUi({ busy: false, open: true }); notify(); return; }
        if (picked.url) setUi({ busy: false, link: picked.url, msg: L.noAuto, msgKind: '' });
        else setUi({ busy: false, msgKind: 'err', msg: zh ? '未取到登录链接，请点击「重新获取」。' : 'No sign-in link was returned; click Retry.' });
      } catch (e) {
        setUi({ busy: false, msgKind: 'err', msg: (zh ? '获取登录链接失败：' : 'Failed to request sign-in link: ') + String(e && e.message || e) });
      }
    }

    // ── 敏感信息模糊（手机号 / 邮箱）────────────────────────────────
    // 手机号（完整号 / 打码号 186******50）。必须带边界：否则 13 位毫秒时间戳
    // （如 1729000000000）会因内部含 11 位子串而被误判为手机号。
    // 边界用「非字母数字」而不是简单 \b：中文/标点相邻仍算边界，但数字串内部不算。
    const PHONE_BODY = '(?:1[3-9]\\d{9}|1\\d{2}\\*{2,}\\d{2})';
    const PHONE_RE = new RegExp('(?:^|[^0-9A-Za-z])' + PHONE_BODY + '(?![0-9A-Za-z])');
    // 敏感信息总集（默认模糊）：手机号 + 邮箱（同样带边界）
    const SENSITIVE_RE = new RegExp('(?:^|[^0-9A-Za-z])' + PHONE_BODY + '(?![0-9A-Za-z])|(?:^|[^\\w.+-])[\\w.+-]+@[\\w-]+\\.[\\w.-]{2,}');
    let blurBound = false;
    let autoObserver = null;
    // 输入框 / 可编辑区域内一律不接管（避免影响用户的正常输入与选择）
    function inEditable(node) {
      let el = node;
      while (el && el.nodeType === 1) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
        el = el.parentElement;
      }
      return false;
    }
    // 受保护区域：输入框 / 可编辑区（DSH 对话输入框底层是 Meta Lexical 的 contenteditable）/ 代码块。
    // 这些地方的 DOM 由编辑器状态机托管，外部改写 nodeValue 会导致光标错乱甚至编辑器崩溃，
    // 因此「双击模糊」与「昵称覆盖」「默认模糊」三条路径都必须先过这道闸。
    function isProtected(el) {
      if (inEditable(el)) return true;
      try {
        if (el.closest && el.closest('[contenteditable="true"],[data-lexical-editor],pre,code,input,textarea')) return true;
      } catch (e) {}
      return false;
    }
    function findSensitive(el) {
      let node = el;
      while (node && node !== document.body && node.nodeType === 1) {
        const t = (node.textContent || '').trim();
        if (t && t.length <= 64 && node.children.length <= 2 && PHONE_RE.test(t)) return node;
        node = node.parentElement;
      }
      return null;
    }
    // 双击任意位置的敏感文本即可模糊 / 还原
    function bindSensitiveBlur() {
      if (blurBound || typeof document === 'undefined') return;
      blurBound = true;
      try {
        document.addEventListener('dblclick', (ev) => {
          const t = ev.target;
          if (!t || t.nodeType !== 1) return;
          if (inEditable(t)) return;              // 输入框/可编辑区域内不接管
          try {
            const sel = window.getSelection && window.getSelection();
            if (sel && String(sel.toString() || '').trim()) return;   // 用户正在划选文本时不接管
          } catch (e) {}
          const target = findSensitive(t);
          if (!target) return;
          target.classList.toggle('dshdlq-blur');
          ev.preventDefault();                    // 阻止双击选中文本
          ev.stopPropagation();                   // 仅命中手机号时才拦截 DSH 自身的双击交互
        }, true);
      } catch (e) { blurBound = false; }
    }
    // 昵称覆盖只用手机号判定（邮箱不替换）
    function leafTextNode(el) {
      const kids = el.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3 && String(kids[i].nodeValue || '').trim()) return kids[i];
      }
      return null;
    }
    /**
     * 自定义昵称覆盖：把页面里由 DSH 自己渲染的手机号（左下角账号栏、设置里的账号区等）
     * 替换为昵称。只改写文本节点的 value（不动 DOM 结构），因此对 React 渲染是安全的；
     * React 若重新渲染回手机号，MutationObserver 会再次覆盖。
     */
    function applyNicknameOverride() {
      if (typeof document === 'undefined') return;
      try {
        const nick = String(prefs.nickname || '').trim();
        // 昵称清空：还原原始手机号
        if (!nick) {
          for (const el of document.querySelectorAll('[data-dshdlq-nick="1"]')) {
            const node = leafTextNode(el);
            if (node) node.nodeValue = el.getAttribute('data-dshdlq-orig') || node.nodeValue;
            el.removeAttribute('data-dshdlq-nick');
            el.removeAttribute('data-dshdlq-orig');
          }
          return;
        }
        for (const el of document.querySelectorAll('span,div,button,a,p,strong,em,small,td')) {
          if (el.children.length > 0) continue;
          if (isProtected(el)) continue;                 // 绝不改写编辑器 / 输入框内的文本
          const node = leafTextNode(el);
          if (!node) continue;
          const t = String(node.nodeValue || '').trim();
          if (el.getAttribute('data-dshdlq-nick') === '1') {
            if (t !== nick) node.nodeValue = nick;   // 昵称改名 / React 回写都会重新覆盖
            continue;
          }
          if (!PHONE_RE.test(t)) continue;
          el.setAttribute('data-dshdlq-orig', t);
          el.setAttribute('data-dshdlq-nick', '1');
          node.nodeValue = nick;
        }
      } catch (e) {}
    }
    // 敏感信息统一刷新：昵称覆盖 + 默认模糊
    function refreshSensitive() { applyNicknameOverride(); autoBlurScan(); }

    // 「默认模糊」：扫描叶子节点并打码，DOM 变化后自动补扫
    function autoBlurScan() {
      if (!prefs.blurByDefault || typeof document === 'undefined') return;
      try {
        // 先撤销「已不再像敏感信息」的自动模糊（例如昵称覆盖了手机号后，同节点残留的类要清掉）
        for (const el of document.querySelectorAll('[data-dshdlq-auto="1"]')) {
          const t = (el.textContent || '').trim();
          if (!t || t.length > 64 || !SENSITIVE_RE.test(t)) {
            el.classList.remove('dshdlq-blur');
            el.removeAttribute('data-dshdlq-auto');
          }
        }
        const nodes = document.querySelectorAll('span,div,td,li,p,a,strong,em,small');
        for (const el of nodes) {
          if (el.children.length > 0) continue;
          if (isProtected(el)) continue;                 // 编辑器 / 输入框 / 代码块内不打码
          if (el.classList.contains('dshdlq-blur')) continue;
          const t = (el.textContent || '').trim();
          if (!t || t.length > 64) continue;
          if (!SENSITIVE_RE.test(t)) continue;
          el.classList.add('dshdlq-blur');
          el.setAttribute('data-dshdlq-auto', '1');
        }
      } catch (e) {}
    }
    function clearAutoBlur() {
      try {
        for (const el of document.querySelectorAll('[data-dshdlq-auto="1"]')) {
          el.classList.remove('dshdlq-blur');
          el.removeAttribute('data-dshdlq-auto');
        }
      } catch (e) {}
    }
    function watchDomForAutoBlur() {
      // 两项功能都关闭时不挂观察器；用户开启任一功能后再挂（见 setPref）
      if (!prefs.blurByDefault && !prefs.nickname) return;
      if (autoObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
      try {
        let timer = null;
        autoObserver = new MutationObserver(() => {
          // 两项功能都关闭时不做任何扫描：避免流式输出等高频 DOM 变化带来的无谓开销
          if (!prefs.blurByDefault && !prefs.nickname) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(refreshSensitive, 300);
        });
        autoObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) { autoObserver = null; }
    }

    // ── 共用视图 ─────────────────────────────────────────────────
    function StatusRow(props) {
      const color = props.signedIn
        ? 'var(--dsw-alias-state-success-primary,#15803d)'
        : props.error ? 'var(--dsw-alias-state-error-primary,#dc2626)' : 'var(--dsw-alias-label-primary,#0f172a)';
      return React.createElement('div', { className: 'dshdlq-row', style: { marginTop: props.tight ? '0' : '10px' } },
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary,#64748b)' } }, L.status + ': '),
        React.createElement('strong', { style: { color } }, props.text)
      );
    }
    function AccountRow() {
      if (!isSignedIn()) return null;
      const line = displayAccount();
      if (!line && !profile) return null;
      const nick = showingNickname();
      return React.createElement('div', { className: 'dshdlq-row', style: { marginTop: '4px' } },
        !nick && profile && profile.avatarUrl ? React.createElement('img', { className: 'dshdlq-avatar', src: profile.avatarUrl, alt: '' }) : null,
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary,#64748b)' } }, (nick ? L.nicknameLine : L.accountLine) + ': '),
        React.createElement('span', null, line || '—')
      );
    }
    function SignedInBody() {
      return React.createElement(React.Fragment, null,
        React.createElement('p', { className: 'dshdlq-desc' }, L.signedInHint),
        React.createElement(StatusRow, { signedIn: true, tight: true, text: L.signedInLabel }),
        React.createElement(AccountRow, null),
        React.createElement('div', { className: 'dshdlq-row' },
          React.createElement('button', { type: 'button', className: 'dshdlq-btn', onClick: recheck }, checked ? L.recheck : L.checking)
        )
      );
    }

    // 偏好设置区块
    function SettingsBlock() {
      const s = useUi();
      const [draft, setDraft] = React.useState(prefs.nickname || '');
      React.useEffect(() => { setDraft(prefs.nickname || ''); }, [prefs.nickname]);
      const commit = () => {
        setPref('nickname', String(draft || '').trim());
        setUi({ saved: true });
        setTimeout(() => setUi({ saved: false }), 1800);
      };
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dshdlq-sep' }),
        React.createElement('div', { className: 'dshdlq-label' }, L.prefsTitle),
        React.createElement('label', { className: 'dshdlq-check' },
          React.createElement('input', {
            type: 'checkbox',
            checked: !!prefs.blurByDefault,
            onChange: (e) => setPref('blurByDefault', e.target.checked)
          }),
          React.createElement('span', null, L.blurDefault)
        ),
        React.createElement('div', { className: 'dshdlq-hint', style: { marginLeft: '24px' } }, L.blurDefaultHint),
        React.createElement('label', { className: 'dshdlq-label' }, L.nickLabel),
        React.createElement('div', { className: 'dshdlq-row', style: { marginTop: 0 } },
          React.createElement('input', {
            className: 'dshdlq-input',
            style: { maxWidth: '260px' },
            value: draft,
            placeholder: L.nickPlaceholder,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') commit(); }
          }),
          React.createElement('button', { type: 'button', className: 'dshdlq-btn dshdlq-primary', onClick: commit }, s.saved ? L.saved : L.save)
        ),
        React.createElement('div', { className: 'dshdlq-hint' }, L.nickHint),
        React.createElement('div', { className: 'dshdlq-hint' }, L.blurHint)
      );
    }

    // ── 弹窗（唯一实例，渲染在 shell.overlay）──────────────────────
    function SignInDialog() {
      ensureStyles();
      const s = useUi();
      const onCopy = async () => {
        try { await navigator.clipboard.writeText(s.link); setUi({ copied: true }); setTimeout(() => setUi({ copied: false }), 2000); }
        catch (e) { setUi({ msgKind: 'err', msg: (zh ? '复制失败，请手动选择链接复制：' : 'Copy failed, please copy manually: ') + s.link }); }
      };
      const onOpen = () => { try { if (s.link) window.open(s.link, '_blank', 'noopener'); } catch (e) {} };
      const onSubmit = async () => {
        const v = String(s.input || '').trim();
        if (!v) { setUi({ msgKind: 'err', msg: L.emptyLink }); return; }
        setUi({ busy: true, msg: '', msgKind: '' });
        try {
          const r = await submitCallbackLink(v);
          if (r.body && r.body.ok) { setUi({ busy: false, msgKind: 'ok', msg: L.okMsg }); detectAccount(); }
          else setUi({ busy: false, msgKind: 'err', msg: (r.body && (r.body.message || r.body.error)) || ('HTTP ' + r.status) });
        } catch (e) { setUi({ busy: false, msgKind: 'err', msg: String(e && e.message || e) }); }
      };
      const head = React.createElement('div', { className: 'dshdlq-head' },
        React.createElement('h3', { className: 'dshdlq-title' }, isSignedIn() ? '✅ ' : '🔑 ', isSignedIn() ? L.signedInLabel : L.title),
        React.createElement('button', { type: 'button', className: 'dshdlq-btn', onClick: () => setUi({ open: false }) }, L.close)
      );
      return React.createElement('div', { className: 'dshdlq-overlay', onClick: (e) => { if (e.target === e.currentTarget) setUi({ open: false }); } },
        React.createElement('div', { className: 'dshdlq-dialog' },
          head,
          isSignedIn()
            ? React.createElement(SignedInBody, null)
            : React.createElement(React.Fragment, null,
                React.createElement('p', { className: 'dshdlq-desc' }, L.desc),
                React.createElement('label', { className: 'dshdlq-label' }, L.linkLabel),
                React.createElement('input', { className: 'dshdlq-input', readOnly: true, value: s.link || '', placeholder: L.starting }),
                React.createElement('div', { className: 'dshdlq-row' },
                  React.createElement('button', { type: 'button', className: 'dshdlq-btn', disabled: !s.link, onClick: onCopy }, s.copied ? L.copied : L.copy),
                  React.createElement('button', { type: 'button', className: 'dshdlq-btn', disabled: !s.link, onClick: onOpen }, L.open),
                  React.createElement('button', { type: 'button', className: 'dshdlq-btn', disabled: s.busy, onClick: beginSignIn }, L.retry)
                ),
                React.createElement('label', { className: 'dshdlq-label' }, L.cbLabel),
                React.createElement('input', { className: 'dshdlq-input', value: s.input, placeholder: L.cbPlaceholder, onChange: (e) => setUi({ input: e.target.value }) }),
                React.createElement('div', { className: 'dshdlq-row' },
                  React.createElement('button', { type: 'button', className: 'dshdlq-btn dshdlq-primary', disabled: s.busy, onClick: onSubmit }, s.busy ? L.submitting : L.submit),
                  React.createElement('button', { type: 'button', className: 'dshdlq-btn', disabled: s.busy, onClick: () => setUi({ open: false }) }, L.cancel)
                ),
                s.msg ? React.createElement('div', { className: 'dshdlq-msg ' + (s.msgKind === 'ok' ? 'dshdlq-ok' : s.msgKind === 'err' ? 'dshdlq-err' : '') }, s.msg) : null
              )
        )
      );
    }

    function RemoteLoginOverlay() {
      const s = useUi();
      useMount(ensureAccount);
      return s.open ? React.createElement(SignInDialog) : null;
    }

    // 官方 settings.models.sign-in 插槽的接替者：未配置 API Key 时，模型设置页原本靠官方
    // 登录引导；补丁把官方弹窗置空后必须由这里顶上，否则该区域会变成空白死区。
    function ModelsSignInEntry() {
      ensureStyles();
      const s = useUi();
      useMount(ensureAccount);
      const active = isActiveAttempt(accountState);
      return React.createElement('div', { className: 'dshdlq-card' },
        React.createElement('div', { className: 'dshdlq-head' },
          React.createElement('h3', { className: 'dshdlq-title' }, isSignedIn() ? '✅ ' : '🔑 ', L.section),
          React.createElement('span', { className: 'dshdlq-badge' }, L.badge)
        ),
        isSignedIn()
          ? React.createElement(SignedInBody, null)
          : React.createElement(React.Fragment, null,
              React.createElement('p', { className: 'dshdlq-desc' }, L.desc),
              React.createElement(StatusRow, {
                tight: true,
                error: s.msgKind === 'err',
                text: s.busy ? L.starting : (active || s.link) ? L.waiting : (checked ? L.idle : L.checking)
              }),
              React.createElement('div', { className: 'dshdlq-row' },
                React.createElement('button', { type: 'button', className: 'dshdlq-btn dshdlq-primary', disabled: s.busy, onClick: beginSignIn }, s.busy ? L.starting : L.getLink)
              )
            )
      );
    }

    function RemoteLoginSection() {
      ensureStyles();
      const s = useUi();
      useMount(ensureAccount);
      const active = isActiveAttempt(accountState);
      const signedInNow = isSignedIn();
      return React.createElement('div', { className: 'dshdlq-card' },
        React.createElement('div', { className: 'dshdlq-head' },
          React.createElement('h2', { className: 'dshdlq-title' }, signedInNow ? '✅ ' : '🔑 ', L.section),
          React.createElement('span', { className: 'dshdlq-badge' }, L.badge)
        ),
        signedInNow
          ? React.createElement(SignedInBody, null)
          : React.createElement(React.Fragment, null,
              React.createElement('p', { className: 'dshdlq-desc' }, L.desc),
              React.createElement(StatusRow, {
                tight: true,
                error: s.msgKind === 'err',
                text: s.busy ? L.starting : (active || s.link) ? L.waiting : (checked ? L.idle : L.checking)
              }),
              React.createElement('div', { className: 'dshdlq-row' },
                React.createElement('button', { type: 'button', className: 'dshdlq-btn dshdlq-primary', disabled: s.busy, onClick: beginSignIn }, s.busy ? L.starting : L.getLink)
              )
              // 弹窗只由全局 shell.overlay 挂载一份；此处再渲染会造成双层 Modal 叠放
            ),
        React.createElement(SettingsBlock, null)
      );
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ensureStyles();   // 必须先于任何打码 class 生效注入样式，否则会出现「已打码但不模糊」的窗口
      loadPrefs();
      startAccountStream(ctx);
      bindSensitiveBlur();
      watchDomForAutoBlur();
      if (typeof window !== 'undefined') {
        try {
          window.addEventListener('dsh-deepseek-remote-login:open', () => {
            if (isSignedIn()) { setUi({ open: true, msg: '', msgKind: '' }); return; }
            setUi({ open: true, msg: '', msgKind: '' });
            beginSignIn();
          });
        } catch (e) {}
      }
      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.section', () => {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'deepseek-remote-login',
            order: 46,
            label: () => L.section
          }, RemoteLoginSection);
        });
        ctx.slots.inject('shell.overlay', () => {
          return ctx.slots.register({ name: 'shell.overlay', id: 'deepseek-remote-login-dialog', order: 90 }, RemoteLoginOverlay);
        });
        // 兑现补丁层注释里的承诺：官方 settings.models.sign-in 被置空后由本插件接管。
        // 该插槽是 kind:"single"（由 settings.onboarding 的 children 声明），官方 AccountOnboarding
        // 虽被补丁置空但**仍占着 priority 0** —— 同优先级再注册会抛
        // "single slot ... already has a registration"。按内核提示用更低的 priority 覆盖（lowest renders）。
        ctx.slots.inject('settings.models.sign-in', () => {
          return ctx.slots.register({ name: 'settings.models.sign-in', id: 'deepseek-remote-login-models', priority: -1 }, ModelsSignInEntry);
        });
      }
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots', 'remote', 'remote.account'];
    return module.exports;
  }
});
