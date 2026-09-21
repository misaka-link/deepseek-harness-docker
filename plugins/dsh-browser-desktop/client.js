window.__ModuleLoader__.load({
  id: '@dsh-custom/dsh-browser-desktop',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');

    const zh = typeof window !== 'undefined' && window.navigator && window.navigator.language.toLowerCase().startsWith('zh');
    const labels = {
      title: zh ? '容器浏览器' : 'Container Browser',
      description: zh ? '控制容器内 Chromium 图形浏览器、虚拟分辨率、CDP 调试与空闲休眠策略。' : 'Controls container Chromium browser, virtual resolution, CDP debugging, and idle sleep policy.',
      resolution: zh ? '虚拟桌面分辨率' : 'Virtual Resolution',
      screenshotQuality: zh ? 'AI 截图工具默认画质' : 'Default Screenshot Quality',
      idleTimeout: zh ? '空闲休眠时间（分钟）' : 'Idle Sleep Timeout (Minutes)',
      enableCdp: zh ? 'CDP 远程调试' : 'CDP Remote Debugging',
      enableSidebarTab: zh ? '在右侧边栏嵌入桌面 Tab (实验性)' : 'Embed Desktop in Right Sidebar (Experimental)',
      enabled: zh ? '启用容器浏览器' : 'Enable Container Browser',
    };

    // ── 只读状态卡：配置权威已统一到 Admin「浏览器与桌面控制」页 ──────
    // 本卡片只展示当前状态并提供跳转，不再提供任何配置写入入口，
    // 避免与 Admin 形成第二个写入点（消除配置多源）。
    let desktopStatusData = null;
    let adminPath = '/admin';

    // VNC 路径是可变更的：Admin 改路径后，【已渲染】的侧边栏 iframe 必须跟着重建，
    // 否则会继续请求旧路径（表现为"必须手动刷新页面"）。这里用一个轻量事件总线
    // 广播变更，配合 localStorage 的 storage 事件实现跨标签页同步。
    const VNC_PATH_KEY = 'dsh_desktop_vnc_path';
    const VNC_PATH_EVENT = 'dsh-desktop-vnc-path-changed';

    function getStoredVncPath() {
      try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(VNC_PATH_KEY)) || '/vnc';
      } catch (e) { return '/vnc'; }
    }

    function setStoredVncPath(p) {
      if (!p || typeof localStorage === 'undefined') return;
      try {
        if (localStorage.getItem(VNC_PATH_KEY) === p) return;
        localStorage.setItem(VNC_PATH_KEY, p);
        window.dispatchEvent(new CustomEvent(VNC_PATH_EVENT, { detail: p }));
      } catch (e) { /* 忽略隐私模式等 localStorage 异常 */ }
    }

    function subscribeVncPath(cb) {
      const onCustom = (e) => cb((e && e.detail) || getStoredVncPath());
      const onStorage = (e) => { if (!e || e.key === VNC_PATH_KEY) cb(getStoredVncPath()); };
      window.addEventListener(VNC_PATH_EVENT, onCustom);
      window.addEventListener('storage', onStorage);
      return () => {
        window.removeEventListener(VNC_PATH_EVENT, onCustom);
        window.removeEventListener('storage', onStorage);
      };
    }

    // P13：加超时，避免网关重启时请求悬挂
    async function loadDesktopStatus() {
      try {
        const r = await fetch('/__api/desktop/status', { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        const data = await r.json();
        desktopStatusData = data?.desktop || null;
        if (data?.paths?.admin) adminPath = data.paths.admin;
        if (data?.paths?.vnc) setStoredVncPath(data.paths.vnc);
        return data;
      } catch (e) { return null; }
    }

    // P13：轮询专用 —— 上一次请求未完成则跳过本次（防请求堆积、状态乱序）
    let desktopPollInFlight = false;
    function pollDesktopStatus() {
      if (desktopPollInFlight) return Promise.resolve(null);
      desktopPollInFlight = true;
      return loadDesktopStatus().finally(() => { desktopPollInFlight = false; });
    }

    function desktopStateText(d) {
      if (!d) return zh ? '未知' : 'Unknown';
      if (d.enabled === false) return zh ? '已彻底停用' : 'Disabled';
      return d.running ? (zh ? '运行中' : 'Running') : (zh ? '已停止 / 休眠中' : 'Stopped');
    }

    function BrowserDesktopCard(props = {}) {
      const isSection = !!props.isSection;
      const [open, setOpen] = React.useState(isSection ? true : false);
      const [status, setStatus] = React.useState(desktopStatusData);
      const [vncBase, setVncBase] = React.useState(getStoredVncPath());

      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          // 失败/被跳过的轮询保持上一次状态，避免卡片在网关重启期间闪成"--"
          pollDesktopStatus().then(d => { if (alive && d) setStatus(d); });
        };
        tick();
        const t = setInterval(tick, 8000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      // VNC 路径变更（Admin 改路径）后，卡片里的跳转链接随之更新
      React.useEffect(() => subscribeVncPath(setVncBase), []);

      const d = status?.desktop || null;
      const rows = [
        [labels.enabled, desktopStateText(d), d && d.enabled === false ? '#ef4444' : (d && d.running ? '#22c55e' : null)],
        [labels.resolution, d ? `${d.width} x ${d.height}` : '--'],
        [labels.idleTimeout, d ? (d.idleTimeoutMinutes === 0 ? (zh ? '始终保持' : 'Always on') : `${d.idleTimeoutMinutes} ${zh ? '分钟' : 'min'}`) : '--'],
        [labels.enableCdp, d ? (d.enableCdp ? `${zh ? '已启用' : 'On'} (:${d.cdpPort})` : (zh ? '已关闭' : 'Off')) : '--'],
        [labels.screenshotQuality, d ? String(d.screenshotQuality || 'high') : '--'],
        [labels.enableSidebarTab, d ? (d.enableSidebarTab ? (zh ? '已开启' : 'On') : (zh ? '已关闭' : 'Off')) : '--']
      ];

      const body = React.createElement(
        'div',
        { style: { display: 'grid', gap: '9px' } },
        React.createElement('p', {
          style: { margin: '0 0 2px', fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary, #64748b)' }
        }, zh
          ? '为避免同一配置出现多个写入点，本插件不再提供重复的配置项：分辨率 / 空闲休眠 / CDP / 截图默认值 / 侧边栏 Tab 统一由管理后台「浏览器与桌面控制」页管理（唯一权威），保存后即时持久化生效。'
          : 'To keep a single source of truth, this plugin no longer duplicates configuration: resolution, idle timeout, CDP, screenshot defaults and the sidebar tab are managed solely in the Admin "Browser & Desktop" page.'),
        ...rows.map(([k, v, color]) => React.createElement(
          'div',
          { key: k, style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' } },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #64748b)' } }, k),
          React.createElement('strong', { style: { color: color || 'var(--dsw-alias-label-primary, #0f172a)' } }, v)
        )),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '4px' } },
          React.createElement('a', {
            href: `${adminPath}/`,
            target: '_blank',
            rel: 'noreferrer',
            style: { fontSize: '13px', color: 'var(--dsw-alias-link, #4176e6)', textDecoration: 'none' }
          }, zh ? '前往管理后台配置 ↗' : 'Configure in Admin ↗'),
          React.createElement('a', {
            href: `${vncBase.replace(/\/+$/, '')}/`,
            target: '_blank',
            rel: 'noreferrer',
            style: { fontSize: '13px', color: 'var(--dsw-alias-link, #4176e6)', textDecoration: 'none' }
          }, zh ? '在新窗口打开桌面 ↗' : 'Open desktop ↗')
        )
      );

      // P16：全部改为自有命名空间 + 内联样式，不再复用上游私有类名（如 .YyYd_a_card），
      // 上游一改名我们的卡片就会失去样式；内联样式则在任何 DSH 版本下都成立。
      const cardStyle = isSection ? {
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l3, #e2e8f0)',
        borderRadius: '12px',
        padding: '20px 24px',
        listStyle: 'none'
      } : {
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l3, #e2e8f0)',
        borderRadius: '10px',
        margin: '6px 0',
        overflow: 'hidden',
        listStyle: 'none'
      };

      return React.createElement(
        isSection ? 'div' : 'li',
        { className: isSection ? 'dsbd-section-card' : 'dsbd-card', style: cardStyle },
        !isSection ? React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsbd-card-header',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: '10px', width: '100%', padding: '12px 14px',
              background: 'transparent', border: 'none', cursor: 'pointer',
              textAlign: 'left', font: 'inherit',
              color: 'var(--dsw-alias-label-primary, #0f172a)'
            }
          },
          React.createElement(
            'span',
            { className: 'dsbd-card-head-text', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            React.createElement('span', { className: 'dsbd-card-name', style: { fontSize: '13.5px', fontWeight: 700 } }, labels.title),
            React.createElement('span', { className: 'dsbd-card-desc', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #64748b)' } }, labels.description)
          ),
          React.createElement(
            'svg',
            {
              className: 'dsbd-card-chevron',
              width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none',
              stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round',
              style: { flexShrink: 0, transition: 'transform .15s ease', transform: open ? 'rotate(180deg)' : 'none' }
            },
            React.createElement('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25' })
          )
        ) : null,
        open ? React.createElement(
          'div',
          { className: 'dsbd-card-body', style: isSection ? { padding: 0, marginTop: 0 } : { padding: '0 14px 14px' } },
          body
        ) : null
      );
    }

    // 注入右侧边栏样式：
    // 1) Tab 标签宽度保护 (防止文字被关闭按钮截断)
    // 2) 桌面面板顶部栏配色 —— 全部使用 DSH 真实主题令牌 (--dsw-alias-*)，
    //    浅色/深色主题下都有足够对比度。注意：
    //    · 不存在 --dsw-alias-bg-subtle / --dsw-alias-fg-muted，误用会落到深色兜底，
    //      在浅色主题下形成"深色栏 + 深色/近黑文字"的隐形问题；
    //    · --dsw-alias-brand-primary 是"黑白对比色"(浅色#0f1115 / 深色#f9fafb)，
    //      不是品牌蓝，不能拿来当链接色，链接应使用 --dsw-alias-link。
    if (typeof document !== 'undefined') {
      const STYLE_ID = 'dsh-browser-desktop-tab-css';
      // P16：不再使用 :has 选择器 + 上游私有类名（上游一改名或旧浏览器不支持该选择器即失效）。
      // Tab 宽度与防截断改由 VncDesktopTabTitle 的 useLayoutEffect 直接写内联样式完成。
      const CSS = `
        .dshDesktopBar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
          padding: 6px 12px;
          font-size: 12px;
          background: var(--dsw-alias-bg-layer-2, #252526);
          border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.3));
          color: var(--dsw-alias-label-secondary, #a1a1aa);
        }
        .dshDesktopBarTitle {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-weight: 500;
          color: var(--dsw-alias-label-primary, #e5e5e5);
        }
        .dshDesktopBarActions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .dshDesktopBarBtn {
          padding: 0;
          border: none;
          background: none;
          font: inherit;
          cursor: pointer;
          color: var(--dsw-alias-label-secondary, #a1a1aa);
        }
        .dshDesktopBarBtn:hover {
          color: var(--dsw-alias-label-primary, #e5e5e5);
        }
        .dshDesktopBarBtn:focus-visible {
          outline: 1px solid var(--dsw-alias-link, #4176e6);
          outline-offset: 2px;
          border-radius: 3px;
        }
        .dshDesktopBarLink {
          color: var(--dsw-alias-link, #4176e6);
          text-decoration: none;
        }
        .dshDesktopBarLink:hover {
          text-decoration: underline;
        }
        .dshDesktopBarLink:focus-visible {
          outline: 1px solid var(--dsw-alias-link, #4176e6);
          outline-offset: 2px;
          border-radius: 3px;
        }
      `;
      let styleEl = document.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        document.head.appendChild(styleEl);
      }
      // 内容变化时同步更新，避免热更新/重复执行时沿用旧样式
      if (styleEl.textContent !== CSS) styleEl.textContent = CSS;
    }

    // 右侧边栏专用 Tab 标题组件 (精致 14px 矢量显示器图标 + 完美防截断)
    function VncDesktopTabTitle() {
      const titleRef = React.useRef(null);

      React.useLayoutEffect(() => {
        const el = titleRef.current;
        if (!el) return;
        // P16：直接给上游 Tab 容器写内联样式（不依赖 :has 选择器）
        const chip = el.closest('[data-dockkit-tab], [data-dockkit-float-grip]');
        if (chip) {
          chip.style.minWidth = '125px';
          chip.style.overflow = 'visible';
        }
      }, []);

      return React.createElement(
        'span',
        {
          ref: titleRef,
          'data-dsh-desktop-tab-title': 'true',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            whiteSpace: 'nowrap',
            fontSize: '13px',
            lineHeight: '1',
            flexShrink: 0
          }
        },
        React.createElement('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { flexShrink: 0, opacity: 0.85 }
        },
          React.createElement('rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }),
          React.createElement('line', { x1: '8', y1: '21', x2: '16', y2: '21' }),
          React.createElement('line', { x1: '12', y1: '17', x2: '12', y2: '21' })
        ),
        React.createElement('span', { style: { whiteSpace: 'nowrap' } }, zh ? '容器桌面' : 'Desktop')
      );
    }

    // 右侧边栏专用内嵌 VNC 容器组件 (当开关开启且上游环境支持 SidebarRight 时渲染)
    function VncDesktopSidebarPane() {
      // 订阅 VNC 路径：Admin 改路径后无需刷新页面，iframe 自动切到新地址重建
      const [storedVncPath, setVncPath] = React.useState(getStoredVncPath());
      React.useEffect(() => subscribeVncPath(setVncPath), []);
      const vncUrl = `${storedVncPath.replace(/\/+$/, '')}/?autoconnect=1&resize=scale`;
      const [reloadKey, setReloadKey] = React.useState(1);

      return React.createElement(
        'div',
        {
          style: {
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: '#181818',
            position: 'relative',
            overflow: 'hidden'
          }
        },
        React.createElement(
          'div',
          { className: 'dshDesktopBar' },
          React.createElement(
            'span',
            { className: 'dshDesktopBarTitle' },
            '🖥️',
            zh ? 'Chromium 容器桌面' : 'Chromium Container Desktop'
          ),
          React.createElement(
            'div',
            { className: 'dshDesktopBarActions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshDesktopBarBtn',
                onClick: () => setReloadKey(k => k + 1)
              },
              zh ? '刷新画面' : 'Refresh'
            ),
            React.createElement(
              'a',
              {
                href: `${storedVncPath.replace(/\/+$/, '')}/`,
                target: '_blank',
                rel: 'noreferrer',
                className: 'dshDesktopBarLink'
              },
              (zh ? '新窗口全屏' : 'Open in Tab') + ' ↗'
            )
          )
        ),
        React.createElement('iframe', {
          key: reloadKey,
          src: vncUrl,
          style: {
            flex: 1,
            width: '100%',
            height: '100%',
            border: 'none',
            background: '#000'
          }
        })
      );
    }

    function BrowserDesktopSection() {
      return React.createElement(
        'div',
        { style: { padding: '24px 28px', maxWidth: '820px' } },
        React.createElement('div', { style: { marginBottom: '20px', borderBottom: '1px solid var(--dsw-alias-border-l3, #e2e8f0)', paddingBottom: '14px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
            React.createElement('h2', { style: { fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--dsw-alias-label-primary, #0f172a)', display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', null, '🖥️'),
              labels.title
            ),
            React.createElement('span', {
              style: {
                fontSize: '12px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '12px',
                background: 'var(--dsw-alias-state-business-tertiary, #e0f2fe)',
                color: 'var(--dsw-alias-state-business-primary, #0284c7)'
              }
            }, zh ? '内置容器套件组件' : 'Builtin Suite Component')
          ),
          React.createElement('p', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #64748b)', margin: 0, lineHeight: 1.5 } }, labels.description)
        ),
        React.createElement(BrowserDesktopCard, { isSection: true })
      );
    }

    function apply(ctx) {
      // 配置权威已统一到 Admin「浏览器与桌面控制」页：客户端不再读写 DSH 设置命名空间。
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        // 1. 现代 DSH 规范 (>= 0.1.5 / 0.1.6)：将“容器浏览器”注册为设置中心的独立一等公民 Section (settings.section)
        // 与 dshmarket 和 dsh-thinking-effort 保持完全一致的注册范式
        ctx.slots.inject('settings.section', () => {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'browser-desktop',
            order: 45,
            label: () => (zh ? '容器浏览器' : 'Container Browser')
          }, BrowserDesktopSection);
        });

        // =========================================================================
        // 【兼容老版本 DSH (<= 0.1.4 / 0.1.5) - 历史向下兼容】
        // 说明：老版本 DSH 在“设置 -> 插件”菜单内通过 settings.plugin.item 插槽装载各插件的配置卡片。
        // 若后续彻底移除对老版本 DSH 的支持，可直接安全删除以下整个代码块：
        // =========================================================================
        ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'browser-desktop',
            order: 80
          }, BrowserDesktopCard);
        });

        // =========================================================================
        // 【兼容老版本 DSH 结束】
        // =========================================================================

        // 2. 右侧边栏 Tab：权威来自网关（Admin「浏览器与桌面控制」页的「右侧边栏桌面 Tab」）
        const injectSidebarTab = (scopedCtx) => {
          window.__DSH_SIDEBAR_RIGHT__ = scopedCtx.sidebarRight;
          window.__DSH_OPEN_SIDEBAR_TAB__ = (kind) => {
            try {
              if (typeof scopedCtx.sidebarRight?.openTab === 'function') {
                scopedCtx.sidebarRight.openTab({ kind });
              }
            } catch (err) {
              console.warn('[dsh-browser-desktop] 呼出右侧边栏 Tab 失败:', err);
            }
          };
          // P13：返回清理函数 —— Cordis 会在依赖失效/插件卸载时调用它回收全局键，
          // 否则插件被卸载后 window 上会残留指向已销毁 ctx 的引用。
          const cleanupGlobals = () => {
            try { delete window.__DSH_SIDEBAR_RIGHT__; } catch {}
            try { delete window.__DSH_OPEN_SIDEBAR_TAB__; } catch {}
          };
              const DESKTOP_ID = '@dsh-custom/dsh-browser-desktop';
              const DESKTOP_KIND = 'vnc-desktop';

              try {
                scopedCtx.sidebarRightTabs?.register?.({
                  id: DESKTOP_ID,
                  kind: DESKTOP_KIND,
                  priority: 'extension',
                  title: () => (zh ? '容器桌面' : 'Container Desktop'),
                  guide: [{
                    order: 20,
                    title: () => (zh ? '容器浏览器桌面' : 'Container Desktop'),
                    description: () => (zh ? '打开容器内置 Chromium 浏览器与 noVNC 实时桌面 (支持 CDP 调试)' : 'Open Chromium browser & noVNC desktop')
                  }]
                });
              } catch (e) {
                console.warn('[dsh-browser-desktop] 注册 sidebar tab 警告:', e.message);
              }

              for (const key of [DESKTOP_ID, DESKTOP_KIND]) {
                scopedCtx.slots.inject('sidebar.right.pane.tab.title', () => {
                  return scopedCtx.slots.register({
                    name: 'sidebar.right.pane.tab.title',
                    key: key
                  }, VncDesktopTabTitle);
                });

                scopedCtx.slots.inject('sidebar.right.pane.tab', () => {
                  return scopedCtx.slots.register({
                    name: 'sidebar.right.pane.tab',
                    key: key
                  }, VncDesktopSidebarPane);
                });
              }
          return cleanupGlobals;
        };
        if (typeof ctx.inject === 'function') {
          loadDesktopStatus()
            .then((data) => {
              if (!data?.desktop?.enableSidebarTab) return;
              try {
                ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scopedCtx) => injectSidebarTab(scopedCtx));
              } catch (err) {
                console.warn('[dsh-browser-desktop] 条件注入右侧边栏依赖失败 (优雅降级):', err.message);
              }
            })
            .catch(() => {});
        }
      }
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots'];
    return module.exports;
  }
});
