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
      resolutionHint: zh ? 'X11 虚拟显示器与浏览器分辨率（默认 1920x1080 1080p，AI 调用时亦可自适应调整）' : 'Virtual resolution (default 1920x1080, AI can also select per tool call).',
      screenshotQuality: zh ? 'AI 截图工具默认画质' : 'Default Screenshot Quality',
      screenshotQualityHint: zh ? 'AI 调用截图工具时的默认画质策略（高画质无损原图 / 中画质体积平衡 / 低画质高压缩）' : 'Default quality for AI screenshot tool (high/medium/low).',
      idleTimeout: zh ? '空闲休眠时间（分钟）' : 'Idle Sleep Timeout (Minutes)',
      idleTimeoutHint: zh ? '无操作自动休眠以节约 CPU/内存资源，设为 0 则不休眠' : 'Automatically stops desktop when idle to save CPU/RAM. Set 0 to disable.',
      enableCdp: zh ? 'CDP 远程调试' : 'CDP Remote Debugging',
      enableCdpHint: zh ? '是否开启 Chromium DevTools 远程调试（AI 自动化任务必须开启）' : 'Whether to enable Chromium DevTools remote debugging (required for AI tools).',
      cdpPort: zh ? 'CDP 调试端口' : 'CDP Debug Port',
      cdpPortHint: zh ? '远程调试监听端口，默认 9222' : 'Remote debugging port, default 9222.',
      vncPath: zh ? 'VNC 访问相对路径' : 'VNC Access Path',
      vncPathHint: zh ? 'noVNC 桌面相对访问路径，默认 /vnc' : 'Relative access path for noVNC desktop, default /vnc.',
      enableSidebarTab: zh ? '在右侧边栏嵌入桌面 Tab (实验性)' : 'Embed Desktop in Right Sidebar (Experimental)',
      enableSidebarTabHint: zh ? '在 Web 界面右侧边栏 (Right Sidebar) 中直接内嵌容器 Chromium 桌面 Tab，可在对话同时并排操作浏览器（默认关闭）' : 'Embed the container Chromium desktop directly in the right sidebar (disabled by default).',
      openDesktop: zh ? '在新标签页打开桌面 (VNC)' : 'Open VNC in New Window',
      openInSidebar: zh ? '在右侧边栏展开桌面' : 'Open in Sidebar',
      discard: zh ? '放弃修改' : 'Discard',
      save: zh ? '保存' : 'Save',
      saving: zh ? '保存中…' : 'Saving…',
      saved: zh ? '已保存并在后台生效' : 'Saved and applied in background'
    };

    function BrowserDesktopCard() {
      const [open, setOpen] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [dirty, setDirty] = React.useState(false);
      const [savedMsg, setSavedMsg] = React.useState(false);

      const [form, setForm] = React.useState({
        resolution: '1920x1080',
        screenshotQuality: 'high',
        idleTimeoutMinutes: 30,
        enableCdp: true,
        cdpPort: 9222,
        vncPath: '/vnc',
        enableSidebarTab: false
      });
      const [initialForm, setInitialForm] = React.useState(null);

      React.useEffect(() => {
        const storedSidebarTab = typeof localStorage !== 'undefined' && localStorage.getItem('dsh_desktop_enable_sidebar_tab') === 'true';
        fetch('/admin/api/status')
          .then(r => r.json())
          .then(data => {
            if (data && data.desktop) {
              const loaded = {
                resolution: (data.desktop.width && data.desktop.height) ? (data.desktop.width + 'x' + data.desktop.height) : '1920x1080',
                screenshotQuality: 'high',
                idleTimeoutMinutes: data.desktop.idleTimeoutMinutes !== undefined ? data.desktop.idleTimeoutMinutes : 30,
                enableCdp: data.desktop.enableCdp !== undefined ? data.desktop.enableCdp : true,
                cdpPort: data.desktop.cdpPort || 9222,
                vncPath: data.paths?.vnc || '/vnc',
                enableSidebarTab: data.desktop.enableSidebarTab !== undefined ? !!data.desktop.enableSidebarTab : storedSidebarTab
              };
              setForm(loaded);
              setInitialForm(loaded);
            }
          })
          .catch(() => {});
      }, []);

      const updateField = (key, val) => {
        setForm(prev => {
          const next = { ...prev, [key]: val };
          setDirty(JSON.stringify(next) !== JSON.stringify(initialForm));
          return next;
        });
      };

      const handleDiscard = (e) => {
        e.stopPropagation();
        if (initialForm) {
          setForm(initialForm);
          setDirty(false);
        }
      };

      const handleSave = async (e) => {
        e.stopPropagation();
        setSaving(true);
        try {
          const parts = form.resolution.split('x');
          const width = parseInt(parts[0]) || 1440;
          const height = parseInt(parts[1]) || 900;
          
          await fetch('/admin/api/desktop/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              width,
              height,
              durationMinutes: form.idleTimeoutMinutes,
              idleTimeoutMinutes: form.idleTimeoutMinutes,
              enableCdp: form.enableCdp,
              cdpPort: form.cdpPort,
              enableSidebarTab: form.enableSidebarTab
            })
          });

          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('dsh_desktop_enable_sidebar_tab', String(form.enableSidebarTab));
          }

          setInitialForm(form);
          setDirty(false);
          setSavedMsg(true);
          setTimeout(() => setSavedMsg(false), 2500);
        } catch (err) {
          alert('保存失败: ' + err.message);
        } finally {
          setSaving(false);
        }
      };

      // 使用 DSH 原生 CSS 类名与规范
      const cardClasses = 'YyYd_a_card' + (open ? ' YyYd_a_cardOpen' : '');
      const chevronClasses = 'YyYd_a_chevron' + (open ? ' YyYd_a_chevronOpen' : '');

      return React.createElement(
        'li',
        { className: cardClasses },
        // 卡片折叠标题行 (与官方样式 100% 对齐)
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'YyYd_a_header',
            'aria-expanded': open,
            onClick: () => setOpen(!open)
          },
          React.createElement(
            'span',
            { className: 'YyYd_a_headText' },
            React.createElement('span', { className: 'YyYd_a_name' }, labels.title),
            React.createElement('span', { className: 'YyYd_a_description' }, labels.description)
          ),
          dirty ? React.createElement('span', { className: 'YyYd_a_pending' }, zh ? '未保存' : 'Unsaved') : null,
          React.createElement(
            'svg',
            {
              className: chevronClasses,
              width: '14',
              height: '14',
              viewBox: '0 0 14 14',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: '1.5',
              strokeLinecap: 'round',
              strokeLinejoin: 'round'
            },
            React.createElement('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25' })
          )
        ),

        // 展开后的表单区域
        open ? React.createElement(
          'div',
          { className: 'YyYd_a_body' },
          // 字段 1: 虚拟分辨率
          React.createElement(
            'div',
            { className: 'At1oFq_field' },
            React.createElement('div', { className: 'At1oFq_head' }, React.createElement('label', { className: 'At1oFq_label' }, labels.resolution)),
            React.createElement(
              'select',
              {
                className: 'At1oFq_input',
                value: form.resolution,
                onChange: e => updateField('resolution', e.target.value)
              },
              React.createElement('option', { value: '1920x1080' }, '1920 x 1080 (1080p 全高清 默认推荐)'),
              React.createElement('option', { value: '1440x900' }, '1440 x 900 (宽屏均衡)'),
              React.createElement('option', { value: '1280x720' }, '1280 x 720 (720p 节能小屏)'),
              React.createElement('option', { value: '2560x1440' }, '2560 x 1440 (2K 超清)')
            ),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.resolutionHint)
          ),

          // 字段 1.5: 截图工具默认画质
          React.createElement(
            'div',
            { className: 'At1oFq_field' },
            React.createElement('div', { className: 'At1oFq_head' }, React.createElement('label', { className: 'At1oFq_label' }, labels.screenshotQuality)),
            React.createElement(
              'select',
              {
                className: 'At1oFq_input',
                value: form.screenshotQuality || 'high',
                onChange: e => updateField('screenshotQuality', e.target.value)
              },
              React.createElement('option', { value: 'high' }, zh ? '高画质 (无损 PNG 原图，默认)' : 'High (Lossless PNG)'),
              React.createElement('option', { value: 'medium' }, zh ? '中画质 (压缩 JPEG 80% 质量，兼顾清晰与体积)' : 'Medium (Balanced JPEG 80%)'),
              React.createElement('option', { value: 'low' }, zh ? '低画质 (压缩 JPEG 40% 质量，极致小体积)' : 'Low (Compact JPEG 40%)')
            ),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.screenshotQualityHint)
          ),

          // 字段 2: 空闲休眠时间
          React.createElement(
            'div',
            { className: 'At1oFq_field' },
            React.createElement('div', { className: 'At1oFq_head' }, React.createElement('label', { className: 'At1oFq_label' }, labels.idleTimeout)),
            React.createElement(
              'select',
              {
                className: 'At1oFq_input',
                value: String(form.idleTimeoutMinutes),
                onChange: e => updateField('idleTimeoutMinutes', parseInt(e.target.value))
              },
              React.createElement('option', { value: '30' }, '30 分钟无操作休眠'),
              React.createElement('option', { value: '60' }, '60 分钟'),
              React.createElement('option', { value: '10' }, '10 分钟'),
              React.createElement('option', { value: '0' }, '0 (始终保持，不休眠)')
            ),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.idleTimeoutHint)
          ),

          // 字段 3: 是否启用 CDP 远程调试
          React.createElement(
            'div',
            { className: 'At1oFq_field' },
            React.createElement('div', { className: 'At1oFq_head' }, React.createElement('label', { className: 'At1oFq_label' }, labels.enableCdp)),
            React.createElement(
              'select',
              {
                className: 'At1oFq_input',
                value: form.enableCdp ? 'true' : 'false',
                onChange: e => updateField('enableCdp', e.target.value === 'true')
              },
              React.createElement('option', { value: 'true' }, zh ? '开启 (AI 工具调用必须)' : 'Enabled'),
              React.createElement('option', { value: 'false' }, zh ? '关闭' : 'Disabled')
            ),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.enableCdpHint)
          ),

          // 字段 4: CDP 调试端口
          React.createElement(
            'div',
            { className: 'At1oFq_field' },
            React.createElement('div', { className: 'At1oFq_head' }, React.createElement('label', { className: 'At1oFq_label' }, labels.cdpPort)),
            React.createElement('input', {
              className: 'At1oFq_input',
              type: 'number',
              value: form.cdpPort,
              onChange: e => updateField('cdpPort', parseInt(e.target.value) || 9222)
            }),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.cdpPortHint)
          ),

          // 字段 5: 是否在 Web 右侧边栏嵌入桌面 Tab (实验性，默认关闭)
          React.createElement(
            'div',
            { className: 'At1oFq_field' },
            React.createElement('div', { className: 'At1oFq_head' }, React.createElement('label', { className: 'At1oFq_label' }, labels.enableSidebarTab)),
            React.createElement(
              'select',
              {
                className: 'At1oFq_input',
                value: form.enableSidebarTab ? 'true' : 'false',
                onChange: e => updateField('enableSidebarTab', e.target.value === 'true')
              },
              React.createElement('option', { value: 'false' }, zh ? '关闭 (默认，点击在新窗口全屏打开)' : 'Disabled (Default, opens in new window)'),
              React.createElement('option', { value: 'true' }, zh ? '开启 (在 Web 右侧边栏中内嵌桌面 Tab)' : 'Enabled (Embed desktop tab in right sidebar)')
            ),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.enableSidebarTabHint)
          ),

          // 底部操作栏 (与官方 PluginCard footer 100% 对齐)
          React.createElement(
            'div',
            { className: 'YyYd_a_footer' },
            savedMsg ? React.createElement('p', { style: { minWidth: 0, color: 'var(--dsw-alias-brand-primary, #1677ff)', flex: 1, margin: 0, fontSize: '12px' } }, '✓ ' + labels.saved) : null,
            React.createElement(
              'a',
              {
                href: form.vncPath + '/',
                target: '_blank',
                rel: 'noreferrer',
                style: {
                  marginRight: 'auto',
                  fontSize: '13px',
                  color: 'var(--dsw-alias-brand-primary, #1677ff)',
                  textDecoration: 'none'
                }
              },
              labels.openDesktop + ' ↗'
            ),
            (form.enableSidebarTab && typeof window !== 'undefined') ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'YyYd_a_discard',
                style: { marginRight: '8px', cursor: 'pointer' },
                onClick: (e) => {
                  e.stopPropagation();
                  if (typeof window.__DSH_OPEN_SIDEBAR_TAB__ === 'function') {
                    window.__DSH_OPEN_SIDEBAR_TAB__('vnc-desktop');
                  } else {
                    alert(zh ? '右侧边栏未就绪，请先保存并刷新页面' : 'Sidebar not ready, please save and refresh');
                  }
                }
              },
              labels.openInSidebar
            ) : null,
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'YyYd_a_discard',
                disabled: !dirty || saving,
                onClick: handleDiscard
              },
              labels.discard
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'YyYd_a_save',
                disabled: !dirty || saving,
                onClick: handleSave
              },
              saving ? labels.saving : labels.save
            )
          )
        ) : null
      );
    }

    // 右侧边栏专用内嵌 VNC 容器组件 (当开关开启且上游环境支持 SidebarRight 时渲染)
    function VncDesktopSidebarPane() {
      const vncUrl = '/vnc/?autoconnect=1&resize=scale';
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
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 12px',
              background: 'var(--dsw-alias-bg-subtle, #252526)',
              borderBottom: '1px solid var(--dsw-alias-border, #333)',
              fontSize: '12px',
              color: 'var(--dsw-alias-fg-muted, #aaa)',
              flexShrink: 0
            }
          },
          React.createElement(
            'span',
            { style: { fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            '🖥️',
            zh ? 'Chromium 容器桌面' : 'Chromium Container Desktop'
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
            React.createElement(
              'button',
              {
                type: 'button',
                style: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '12px', padding: 0 },
                onClick: () => setReloadKey(k => k + 1)
              },
              zh ? '刷新画面' : 'Refresh'
            ),
            React.createElement(
              'a',
              {
                href: '/vnc/',
                target: '_blank',
                rel: 'noreferrer',
                style: { color: 'var(--dsw-alias-brand-primary, #1677ff)', textDecoration: 'none' }
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

    function apply(ctx) {
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        // 1. 注册设置中心插件配置卡片 (始终加载)
        ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'browser-desktop',
            order: 80
          }, BrowserDesktopCard);
        });

        // 2. 检查右侧边栏 Tab 开关状态 (默认关闭，用户在设置中开启后生效)
        const isSidebarTabEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('dsh_desktop_enable_sidebar_tab') === 'true';

        if (isSidebarTabEnabled && typeof ctx.inject === 'function') {
          try {
            ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scopedCtx) => {
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
                  }, () => React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                    React.createElement('span', null, '🖥️'),
                    React.createElement('span', null, zh ? '容器桌面' : 'Desktop')
                  ));
                });

                scopedCtx.slots.inject('sidebar.right.pane.tab', () => {
                  return scopedCtx.slots.register({
                    name: 'sidebar.right.pane.tab',
                    key: key
                  }, VncDesktopSidebarPane);
                });
              }
            });
          } catch (err) {
            console.warn('[dsh-browser-desktop] 条件注入右侧边栏依赖失败 (优雅降级):', err.message);
          }
        }
      }
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots'];
    return module.exports;
  }
});
