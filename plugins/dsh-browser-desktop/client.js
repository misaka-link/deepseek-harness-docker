window.__ModuleLoader__.load({
  id: '@dsh-custom/dsh-browser-desktop',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');

    let pluginCtx = null;

    function getLocaleService() {
      if (!pluginCtx) return null;
      try { return typeof pluginCtx.get === 'function' ? pluginCtx.get('locale') : pluginCtx.locale; } catch { return pluginCtx.locale || null; }
    }

    function detectLocaleCode() {
      const loc = getLocaleService();
      const snap = loc && typeof loc.getSnapshot === 'function' ? loc.getSnapshot() : null;
      const raw = (snap && snap.active)
        || (typeof window !== 'undefined' && window.navigator && window.navigator.language)
        || 'en';
      const primary = String(raw).toLowerCase().split(/[-_]/)[0];
      return ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'].includes(primary) ? primary : 'en';
    }

    const LABELS = {
      zh: {
        title: '容器浏览器',
        description: '控制容器内 Chromium 图形浏览器、虚拟分辨率、CDP 调试与空闲休眠策略。',
        badge: '内置容器套件组件',
        notice: '为避免同一配置出现多个写入点，分辨率 / 空闲休眠 / CDP / 截图默认值 / 侧边栏 Tab 统一由管理后台「浏览器与桌面控制」页管理（唯一权威），保存后即时持久化生效。',
        enabled: '容器浏览器状态',
        resolution: '虚拟桌面分辨率',
        screenshotQuality: 'AI 截图默认画质',
        idleTimeout: '空闲休眠时间',
        enableCdp: 'CDP 远程调试',
        enableSidebarTab: '右侧边栏嵌入桌面 Tab',
        unknown: '未知',
        disabled: '已彻底停用',
        running: '运行中',
        stopped: '已停止 / 休眠中',
        alwaysOn: '始终保持',
        minutesUnit: '分钟',
        on: '已开启',
        off: '已关闭',
        openAdmin: '前往管理后台配置 ↗',
        openDesktop: '在新窗口打开桌面 ↗',
        tabLabel: '容器桌面',
        barTitle: 'Chromium 容器桌面',
        refresh: '刷新画面',
        openInTab: '新窗口全屏 ↗',
        guideTitle: '容器浏览器桌面',
        guideDesc: '打开容器内置 Chromium 浏览器与 noVNC 实时桌面 (支持 CDP 调试)'
      },
      en: {
        title: 'Container Browser',
        description: 'Controls container Chromium browser, virtual resolution, CDP debugging, and idle sleep policy.',
        badge: 'Builtin Suite Component',
        notice: 'To keep a single source of truth, resolution, idle sleep, CDP, screenshot defaults, and sidebar tab settings are managed solely in the Admin "Browser & Desktop" panel.',
        enabled: 'Browser Status',
        resolution: 'Virtual Resolution',
        screenshotQuality: 'Default Screenshot Quality',
        idleTimeout: 'Idle Sleep Timeout',
        enableCdp: 'CDP Remote Debugging',
        enableSidebarTab: 'Embed Desktop in Right Sidebar',
        unknown: 'Unknown',
        disabled: 'Disabled',
        running: 'Running',
        stopped: 'Stopped / Sleeping',
        alwaysOn: 'Always on',
        minutesUnit: 'min',
        on: 'On',
        off: 'Off',
        openAdmin: 'Configure in Admin ↗',
        openDesktop: 'Open desktop ↗',
        tabLabel: 'Desktop',
        barTitle: 'Chromium Container Desktop',
        refresh: 'Refresh',
        openInTab: 'Open in Tab ↗',
        guideTitle: 'Container Desktop',
        guideDesc: 'Open built-in Chromium browser & noVNC desktop (CDP enabled)'
      },
      ja: {
        title: 'コンテナブラウザ',
        description: 'コンテナ内の Chromium ブラウザ、仮想解像度、CDP デバッグ、スリープ設定を管理します。',
        badge: '内蔵スイートコンポーネント',
        notice: '設定の単一ソースを維持するため、解像度・スリープ・CDP・スクリーンショット画質・サイドバー設定は管理画面「ブラウザとデスクトップ」から一元管理されます。',
        enabled: 'ブラウザ状態',
        resolution: '仮想解像度',
        screenshotQuality: '既定のスクリーンショット画質',
        idleTimeout: 'アイドルスリープ',
        enableCdp: 'CDP リモートデバッグ',
        enableSidebarTab: '右サイドバーにデスクトップを埋め込む',
        unknown: '不明',
        disabled: '無効',
        running: '実行中',
        stopped: '停止 / スリープ中',
        alwaysOn: '常時稼働',
        minutesUnit: '分',
        on: 'オン',
        off: 'オフ',
        openAdmin: '管理画面で設定 ↗',
        openDesktop: '新しいタブで開く ↗',
        tabLabel: 'デスクトップ',
        barTitle: 'Chromium コンテナデスクトップ',
        refresh: '再読み込み',
        openInTab: '新しいタブで開く ↗',
        guideTitle: 'コンテナデスクトップ',
        guideDesc: '内蔵 Chromium ブラウザと noVNC デスクトップを開く'
      },
      es: {
        title: 'Navegador del contenedor',
        description: 'Controla el navegador Chromium del contenedor, resolución virtual, CDP y suspensión por inactividad.',
        badge: 'Componente integrado',
        notice: 'Para mantener una única fuente de configuración, todos los parámetros del escritorio se gestionan en el panel de Administración.',
        enabled: 'Estado del navegador',
        resolution: 'Resolución virtual',
        screenshotQuality: 'Calidad de captura predeterminada',
        idleTimeout: 'Tiempo de suspensión',
        enableCdp: 'Depuración remota CDP',
        enableSidebarTab: 'Incrustar escritorio en la barra lateral',
        unknown: 'Desconocido',
        disabled: 'Desactivado',
        running: 'En ejecución',
        stopped: 'Detenido',
        alwaysOn: 'Siempre activo',
        minutesUnit: 'min',
        on: 'Activado',
        off: 'Desactivado',
        openAdmin: 'Configurar en Admin ↗',
        openDesktop: 'Abrir escritorio ↗',
        tabLabel: 'Escritorio',
        barTitle: 'Escritorio Chromium del contenedor',
        refresh: 'Actualizar',
        openInTab: 'Abrir en pestaña ↗',
        guideTitle: 'Escritorio del contenedor',
        guideDesc: 'Abrir Chromium integrado y escritorio noVNC'
      },
      fr: {
        title: 'Navigateur conteneur',
        description: 'Contrôle le navigateur Chromium du conteneur, la résolution virtuelle, CDP et la mise en veille.',
        badge: 'Composant intégré',
        notice: 'Pour conserver une source de vérité unique, tous les paramètres du bureau sont gérés dans la console Admin.',
        enabled: 'État du navigateur',
        resolution: 'Résolution virtuelle',
        screenshotQuality: 'Qualité de capture par défaut',
        idleTimeout: 'Délai de veille',
        enableCdp: 'Débogage distant CDP',
        enableSidebarTab: 'Intégrer dans la barre latérale',
        unknown: 'Inconnu',
        disabled: 'Désactivé',
        running: 'En cours',
        stopped: 'Arrêté',
        alwaysOn: 'Toujours actif',
        minutesUnit: 'min',
        on: 'Activé',
        off: 'Désactivé',
        openAdmin: 'Configurer dans Admin ↗',
        openDesktop: 'Ouvrir le bureau ↗',
        tabLabel: 'Bureau',
        barTitle: 'Bureau Chromium du conteneur',
        refresh: 'Actualiser',
        openInTab: 'Ouvrir dans un onglet ↗',
        guideTitle: 'Bureau du conteneur',
        guideDesc: 'Ouvrir Chromium intégré et le bureau noVNC'
      },
      de: {
        title: 'Container-Browser',
        description: 'Steuert den Chromium-Browser im Container, virtuelle Auflösung, CDP-Debugging und Ruhemodus.',
        badge: 'Integrierte Komponente',
        notice: 'Alle Desktop- und Browsereinstellungen werden zentral in der Admin-Konsole verwaltet.',
        enabled: 'Browser-Status',
        resolution: 'Virtuelle Auflösung',
        screenshotQuality: 'Standard-Screenshot-Qualität',
        idleTimeout: 'Ruhemodus-Zeitlimit',
        enableCdp: 'CDP-Remote-Debugging',
        enableSidebarTab: 'Desktop in rechter Seitenleiste',
        unknown: 'Unbekannt',
        disabled: 'Deaktiviert',
        running: 'Aktiv',
        stopped: 'Gestoppt',
        alwaysOn: 'Immer aktiv',
        minutesUnit: 'Min.',
        on: 'Ein',
        off: 'Aus',
        openAdmin: 'In Admin konfigurieren ↗',
        openDesktop: 'Desktop öffnen ↗',
        tabLabel: 'Desktop',
        barTitle: 'Chromium Container-Desktop',
        refresh: 'Aktualisieren',
        openInTab: 'In neuem Tab ↗',
        guideTitle: 'Container-Desktop',
        guideDesc: 'Integrierten Chromium-Browser & noVNC-Desktop öffnen'
      },
      ru: {
        title: 'Браузер контейнера',
        description: 'Управление Chromium в контейнере, разрешением экрана, CDP и спящим режимом.',
        badge: 'Встроенный компонент',
        notice: 'Все параметры рабочего стола и браузера централизованно управляются в панели администратора.',
        enabled: 'Состояние браузера',
        resolution: 'Виртуальное разрешение',
        screenshotQuality: 'Качество скриншотов',
        idleTimeout: 'Таймаут сна',
        enableCdp: 'Удалённая отладка CDP',
        enableSidebarTab: 'Вкладка рабочего стола справа',
        unknown: 'Неизвестно',
        disabled: 'Отключено',
        running: 'Работает',
        stopped: 'Остановлен',
        alwaysOn: 'Всегда включён',
        minutesUnit: 'мин',
        on: 'Вкл',
        off: 'Выкл',
        openAdmin: 'Настроить в Admin ↗',
        openDesktop: 'Открыть рабочий стол ↗',
        tabLabel: 'Рабочий стол',
        barTitle: 'Рабочий стол Chromium',
        refresh: 'Обновить',
        openInTab: 'В новой вкладке ↗',
        guideTitle: 'Рабочий стол контейнера',
        guideDesc: 'Открыть встроенный Chromium и рабочий стол noVNC'
      },
      pt: {
        title: 'Navegador do contêiner',
        description: 'Controla o navegador Chromium do contêiner, resolução virtual, depuração CDP e suspensão.',
        badge: 'Componente integrado',
        notice: 'Todas as configurações do navegador e área de trabalho são gerenciadas exclusivamente no painel Admin.',
        enabled: 'Status do navegador',
        resolution: 'Resolução virtual',
        screenshotQuality: 'Qualidade padrão de captura',
        idleTimeout: 'Tempo de suspensão',
        enableCdp: 'Depuração remota CDP',
        enableSidebarTab: 'Incorporar na barra lateral',
        unknown: 'Desconhecido',
        disabled: 'Desativado',
        running: 'Em execução',
        stopped: 'Parado',
        alwaysOn: 'Sempre ativo',
        minutesUnit: 'min',
        on: 'Ativado',
        off: 'Desativado',
        openAdmin: 'Configurar no Admin ↗',
        openDesktop: 'Abrir área de trabalho ↗',
        tabLabel: 'Desktop',
        barTitle: 'Área de trabalho Chromium',
        refresh: 'Atualizar',
        openInTab: 'Abrir em aba ↗',
        guideTitle: 'Área de trabalho do contêiner',
        guideDesc: 'Abrir Chromium integrado e área de trabalho noVNC'
      }
    };

    function getLabels() {
      return LABELS[detectLocaleCode()] || LABELS.en;
    }

    function useLocaleSync() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const loc = getLocaleService();
        if (!loc || typeof loc.subscribe !== 'function') return;
        return loc.subscribe(() => { force((v) => v + 1); });
      }, []);
    }

    let desktopStatusData = null;
    let adminPath = '/admin';

    const VNC_PATH_KEY = 'dsh_desktop_vnc_path';
    const VNC_PATH_EVENT = 'dsh-desktop-vnc-path-changed';

    function getStoredVncPath() {
      try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(VNC_PATH_KEY)) || '/vnc';
      } catch { return '/vnc'; }
    }

    function setStoredVncPath(p) {
      if (!p || typeof localStorage === 'undefined') return;
      try {
        if (localStorage.getItem(VNC_PATH_KEY) === p) return;
        localStorage.setItem(VNC_PATH_KEY, p);
        window.dispatchEvent(new CustomEvent(VNC_PATH_EVENT, { detail: p }));
      } catch {}
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

    async function loadDesktopStatus() {
      try {
        const r = await fetch('/__api/desktop/status', { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        const data = await r.json();
        desktopStatusData = data?.desktop || null;
        if (data?.paths?.admin) adminPath = data.paths.admin;
        if (data?.paths?.vnc) setStoredVncPath(data.paths.vnc);
        return data;
      } catch { return null; }
    }

    let desktopPollInFlight = false;
    function pollDesktopStatus() {
      if (desktopPollInFlight) return Promise.resolve(null);
      desktopPollInFlight = true;
      return loadDesktopStatus().finally(() => { desktopPollInFlight = false; });
    }

    function desktopStateText(d, L) {
      if (!d) return L.unknown;
      if (d.enabled === false) return L.disabled;
      return d.running ? L.running : L.stopped;
    }

    function BrowserDesktopCard() {
      useLocaleSync();
      const L = getLabels();
      const [status, setStatus] = React.useState(desktopStatusData ? { desktop: desktopStatusData } : null);
      const [vncBase, setVncBase] = React.useState(getStoredVncPath());

      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          pollDesktopStatus().then((d) => { if (alive && d) setStatus(d); });
        };
        tick();
        const t = setInterval(tick, 8000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      React.useEffect(() => subscribeVncPath(setVncBase), []);

      const d = status?.desktop || null;
      const stateColor = d && d.enabled === false
        ? 'var(--dsw-alias-state-error-primary, #ef4444)'
        : (d && d.running ? 'var(--dsw-alias-state-success-primary, #22c55e)' : null);

      const rows = [
        [L.enabled, desktopStateText(d, L), stateColor],
        [L.resolution, d ? `${d.width} x ${d.height}` : '--'],
        [L.idleTimeout, d ? (d.idleTimeoutMinutes === 0 ? L.alwaysOn : `${d.idleTimeoutMinutes} ${L.minutesUnit}`) : '--'],
        [L.enableCdp, d ? (d.enableCdp ? `${L.on} (:${d.cdpPort})` : L.off) : '--'],
        [L.screenshotQuality, d ? String(d.screenshotQuality || 'high') : '--'],
        [L.enableSidebarTab, d ? (d.enableSidebarTab ? L.on : L.off) : '--']
      ];

      return React.createElement(
        'div',
        {
          className: 'dsbd-section-card',
          style: {
            background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-settings-card-fill, #ffffff))',
            border: '1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l3, #e2e8f0))',
            borderRadius: 'var(--dsw-radius-lg, 12px)',
            padding: '20px 24px',
            color: 'var(--dsw-alias-label-primary, #0f172a)'
          }
        },
        React.createElement(
          'div',
          { style: { display: 'grid', gap: '10px' } },
          React.createElement('p', {
            style: { margin: '0 0 2px', fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary, #64748b)' }
          }, L.notice),
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
            }, L.openAdmin),
            React.createElement('a', {
              href: `${vncBase.replace(/\/+$/, '')}/`,
              target: '_blank',
              rel: 'noreferrer',
              style: { fontSize: '13px', color: 'var(--dsw-alias-link, #4176e6)', textDecoration: 'none' }
            }, L.openDesktop)
          )
        )
      );
    }

    if (typeof document !== 'undefined') {
      const STYLE_ID = 'dsh-browser-desktop-tab-css';
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
        .dshDesktopBarBtn:focus-visible,
        .dshDesktopBarLink:focus-visible {
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
      `;
      let styleEl = document.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        document.head.appendChild(styleEl);
      }
      if (styleEl.textContent !== CSS) styleEl.textContent = CSS;
    }

    function GuideArtworkContainerDesktop(props) {
      const size = (props && props.size) || 36;
      const className = props && props.className ? props.className : undefined;
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          className,
          'aria-hidden': 'true',
          focusable: 'false',
          viewBox: '0 0 36 36',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg'
        },
        React.createElement('rect', {
          x: '7.2',
          y: '8.5',
          width: '21.6',
          height: '15',
          rx: '2.6',
          stroke: '#15AABF',
          strokeWidth: '2'
        }),
        React.createElement('path', {
          d: 'M7.8 13.2H28.2',
          stroke: '#3BC9DB',
          strokeWidth: '1.6',
          strokeLinecap: 'round'
        }),
        React.createElement('circle', { cx: '10.5', cy: '10.9', r: '0.85', fill: '#15AABF' }),
        React.createElement('circle', { cx: '13.1', cy: '10.9', r: '0.85', fill: '#3BC9DB' }),
        React.createElement('path', {
          d: 'M18 23.5V27.2',
          stroke: '#15AABF',
          strokeWidth: '2',
          strokeLinecap: 'round'
        }),
        React.createElement('path', {
          d: 'M13.2 27.2H22.8',
          stroke: '#15AABF',
          strokeWidth: '2',
          strokeLinecap: 'round'
        })
      );
    }

    function VncDesktopTabTitle() {
      useLocaleSync();
      const L = getLabels();
      const titleRef = React.useRef(null);

      React.useLayoutEffect(() => {
        const el = titleRef.current;
        if (!el) return;
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
        React.createElement('span', { style: { whiteSpace: 'nowrap' } }, L.tabLabel)
      );
    }

    function VncDesktopSidebarPane() {
      useLocaleSync();
      const L = getLabels();
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
            background: 'var(--dsw-alias-bg-base, #151517)',
            position: 'relative',
            overflow: 'hidden'
          }
        },
        React.createElement(
          'div',
          { className: 'dshDesktopBar' },
          React.createElement('span', { className: 'dshDesktopBarTitle' }, L.barTitle),
          React.createElement(
            'div',
            { className: 'dshDesktopBarActions' },
            React.createElement('button', {
              type: 'button',
              className: 'dshDesktopBarBtn',
              onClick: () => setReloadKey((k) => k + 1)
            }, L.refresh),
            React.createElement('a', {
              href: `${storedVncPath.replace(/\/+$/, '')}/`,
              target: '_blank',
              rel: 'noreferrer',
              className: 'dshDesktopBarLink'
            }, L.openInTab)
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
      useLocaleSync();
      const L = getLabels();
      return React.createElement(
        'div',
        { style: { padding: '24px 28px', maxWidth: '820px' } },
        React.createElement(
          'div',
          {
            style: {
              marginBottom: '20px',
              borderBottom: '1px solid var(--dsw-alias-border-l3, #e2e8f0)',
              paddingBottom: '14px'
            }
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
            React.createElement('h2', {
              style: {
                fontSize: '18px',
                fontWeight: 700,
                margin: 0,
                color: 'var(--dsw-alias-label-primary, #0f172a)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }
            }, React.createElement(GuideArtworkContainerDesktop, { size: 22 }), L.title),
            React.createElement('span', {
              style: {
                fontSize: '12px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '12px',
                background: 'var(--dsw-alias-state-business-tertiary, #e0f2fe)',
                color: 'var(--dsw-alias-state-business-primary, #0284c7)'
              }
            }, L.badge)
          ),
          React.createElement('p', {
            style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #64748b)', margin: 0, lineHeight: 1.5 }
          }, L.description)
        ),
        React.createElement(BrowserDesktopCard)
      );
    }

    function apply(ctx) {
      pluginCtx = ctx;
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        // 仅保留现代 settings.section 视图（v1.0.0 移除 <=0.1.5 的 settings.plugin.item 旧插槽）
        ctx.slots.inject('settings.section', () => {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'browser-desktop',
            order: 45,
            label: () => getLabels().title
          }, BrowserDesktopSection);
        });

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
              title: () => getLabels().tabLabel,
              guide: [{
                id: 'desktop',
                order: 20,
                title: () => getLabels().guideTitle,
                description: () => getLabels().guideDesc,
                icon: GuideArtworkContainerDesktop
              }]
            });
          } catch (e) {
            console.warn('[dsh-browser-desktop] 注册 sidebar tab 警告:', e.message);
          }

          for (const key of [DESKTOP_ID, DESKTOP_KIND]) {
            scopedCtx.slots.inject('sidebar.right.pane.tab.title', () => {
              return scopedCtx.slots.register({
                name: 'sidebar.right.pane.tab.title',
                key
              }, VncDesktopTabTitle);
            });

            scopedCtx.slots.inject('sidebar.right.pane.tab', () => {
              return scopedCtx.slots.register({
                name: 'sidebar.right.pane.tab',
                key
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
                console.warn('[dsh-browser-desktop] 条件注入右侧边栏依赖失败:', err.message);
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
