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
      resolutionHint: zh ? 'X11 虚拟显示器分辨率（例如 1440x900 或 1920x1080）' : 'X11 virtual display resolution (e.g. 1440x900 or 1920x1080).',
      idleTimeout: zh ? '空闲休眠时间（分钟）' : 'Idle Sleep Timeout (Minutes)',
      idleTimeoutHint: zh ? '无操作自动休眠以节约 CPU/内存资源，设为 0 则不休眠' : 'Automatically stops desktop when idle to save CPU/RAM. Set 0 to disable.',
      enableCdp: zh ? 'CDP 远程调试' : 'CDP Remote Debugging',
      enableCdpHint: zh ? '是否开启 Chromium DevTools 远程调试（AI 自动化任务必须开启）' : 'Whether to enable Chromium DevTools remote debugging (required for AI tools).',
      cdpPort: zh ? 'CDP 调试端口' : 'CDP Debug Port',
      cdpPortHint: zh ? '远程调试监听端口，默认 9222' : 'Remote debugging port, default 9222.',
      vncPath: zh ? 'VNC 访问相对路径' : 'VNC Access Path',
      vncPathHint: zh ? 'noVNC 桌面相对访问路径，默认 /vnc' : 'Relative access path for noVNC desktop, default /vnc.',
      openDesktop: zh ? '在新标签页打开桌面 (VNC)' : 'Open VNC in New Window',
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
        resolution: '1440x900',
        idleTimeoutMinutes: 30,
        enableCdp: true,
        cdpPort: 9222,
        vncPath: '/vnc'
      });
      const [initialForm, setInitialForm] = React.useState(null);

      React.useEffect(() => {
        fetch('/admin/api/status')
          .then(r => r.json())
          .then(data => {
            if (data && data.desktop) {
              const loaded = {
                resolution: (data.desktop.width && data.desktop.height) ? (data.desktop.width + 'x' + data.desktop.height) : '1440x900',
                idleTimeoutMinutes: data.desktop.idleTimeoutMinutes !== undefined ? data.desktop.idleTimeoutMinutes : 30,
                enableCdp: data.desktop.enableCdp !== undefined ? data.desktop.enableCdp : true,
                cdpPort: data.desktop.cdpPort || 9222,
                vncPath: data.paths?.vnc || '/vnc'
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
              cdpPort: form.cdpPort
            })
          });

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
              React.createElement('option', { value: '1440x900' }, '1440 x 900 (默认推荐)'),
              React.createElement('option', { value: '1920x1080' }, '1920 x 1080 (高清)'),
              React.createElement('option', { value: '1280x720' }, '1280 x 720 (小屏节能)')
            ),
            React.createElement('p', { className: 'At1oFq_hint' }, labels.resolutionHint)
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

    function apply(ctx) {
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'browser-desktop',
            order: 80
          }, BrowserDesktopCard);
        });
      }
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots'];
    return module.exports;
  }
});
