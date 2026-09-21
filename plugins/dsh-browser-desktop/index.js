import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-browser-desktop';
export const inject = ['tools', 'systemPrompt', 'settings'];

// 插件自身【不再向 DSH 设置中心声明任何可配置字段】：
// 浏览器/桌面的全部配置权威 = 网关持久化文件 gateway.config.json
// （Admin「浏览器与桌面控制」页是唯一配置入口）。
// 保留一个空 Schema 是为了让 DSH 的插件配置渲染器没有任何字段可展示，
// 从根源上杜绝「看着能改、其实改了没用」的幽灵配置表单。
export const Config = z.object({});

export function apply(ctx, config = {}) {
  // 实时配置状态，初始由系统注入，随设置中心热更新动态刷新
  let activeConfig = {
    enabled: true,
    resolution: '1920x1080',
    screenshotQuality: 'high',
    screenshotDir: '',
    idleTimeoutMinutes: 30,
    enableCdp: true,
    cdpPort: 9222,
    vncPath: '/vnc',
    enableSidebarTab: false,
    ...config
  };

  // enabled 主开关的可注销注册句柄：工具 disposer 数组 / 提示词段 disposer
  const registeredTools = [];
  let registeredPrompt = null;
  let enabledState = null;

  const cdpPort = () => activeConfig.cdpPort || 9222;
  const cdpBase = () => `http://127.0.0.1:${cdpPort()}`;
  const vncPath = () => activeConfig.vncPath || '/vnc';

  // 内部网关管理接口基地址 (动态读取 PROXY_PORT)
  const gatewayControlUrl = () => `http://127.0.0.1:${process.env.PROXY_PORT || 3080}/__internal/desktop`;

  // 内部接口共享密钥（M14）：网关启动时生成 0600 文件，插件每次调用前读取并带上。
  // 只有容器内的插件能读到该文件，因此外部即使能连到网关也无法调用内部接口。
  const INTERNAL_TOKEN_FILE = process.env.DSH_INTERNAL_TOKEN_FILE || '/root/.dsh/.internal-api-token';
  let cachedInternalToken = null;
  function readInternalToken() {
    try {
      const raw = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim();
      if (raw) { cachedInternalToken = raw; return raw; }
    } catch {}
    return cachedInternalToken;
  }

  async function callDesktopManager(endpoint, body = {}) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = readInternalToken();
      if (token) headers['x-dsh-internal-token'] = token;
      const res = await fetch(`${gatewayControlUrl()}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // 超时兜底：防止桌面管理端异常挂起时工具调用永久阻塞
        // (start 在极端情况下需等待陈旧显示/端口释放，故留 30s 余量)
        signal: AbortSignal.timeout(30000)
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!data) {
        return { ok: false, error: `桌面管理接口返回空响应 (HTTP ${res.status})` };
      }
      if (!res.ok && data.ok !== false) {
        return { ok: false, error: `桌面管理接口返回 HTTP ${res.status}` };
      }
      return data;
    } catch (err) {
      // R1-c：停用与在途调用的竞态——若本次调用期间浏览器被彻底停用，把底层网络/CDP
      // 报错归一成明确的"已停用"提示，避免被误判成浏览器故障。
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        return { ok: false, error: '容器图形浏览器桌面已在管理后台被彻底停用，本次操作已中止' };
      }
      return { ok: false, error: err.message };
    }
  }

  // ── 权威配置：唯一来源是网关（Admin「浏览器与桌面控制」页） ─────────
  // 本插件【不再注册】DSH 设置命名空间（此前会渲染出一个改了也没用的"幽灵配置"表单）。
  // 旧版本 settings.yaml 里 browser-desktop 段的用户显式设置仅在首次启动时做一次性迁移，
  // 迁移通过读取【原始 user section】(ctx.settings.section) 完成，无需注册命名空间。
  const LEGACY_MARKER = process.env.BROWSER_DESKTOP_LEGACY_MARKER || '/root/.dsh/.browser-desktop-authority-migrated';
  const LEGACY_MARKER_FALLBACK = process.env.BROWSER_DESKTOP_LEGACY_MARKER_FALLBACK || '/tmp/.browser-desktop-authority-migrated';
  const legacyMigrated = () => fs.existsSync(LEGACY_MARKER) || fs.existsSync(LEGACY_MARKER_FALLBACK);
  const markLegacyMigrated = () => {
    const content = new Date().toISOString() + '\n';
    try { fs.writeFileSync(LEGACY_MARKER, content, 'utf8'); return; } catch {}
    try { fs.writeFileSync(LEGACY_MARKER_FALLBACK, content, 'utf8'); } catch {}
  };

  // 读取旧 DSH 设置文档里 browser-desktop 段的原始 user section（只读、不注册命名空间）。
  // 返回 null 表示该段不存在（或当前 DSH 不提供 section API）。
  function readLegacySection() {
    try {
      if (!ctx.settings || typeof ctx.settings.section !== 'function') return null;
      const section = ctx.settings.section('browser-desktop');
      return section && typeof section === 'object' && !Array.isArray(section) ? section : null;
    } catch {
      return null;
    }
  }

  // ── 权威配置：直接读网关持久化配置文件（同步、微秒级、零网络、零轮询） ──
  // 停/启浏览器是管理动作，会伴随服务重启；插件在【启动时】与【每次工具调用前】读一次文件即可，
  // 因此完全不需要轮询或文件监听。
  const CONFIG_FILE = process.env.GATEWAY_CONFIG_FILE || '/root/.dsh/gateway.config.json';

  // P17：区分「文件不存在」与「文件存在但解析失败」两种情形。
  //   - 不存在（ENOENT）：全新容器首启、网关尚未落盘 → 保持当前状态，不算异常；
  //   - 解析失败/读取失败：说明管理员已写好的配置被写坏（或磁盘异常），
  //     **绝不能**因此回退成"启用"把 AI 工具重新挂上（管理员可能已明确停用），
  //     这里记录 error 并保持上一次成功读取的快照。
  let lastGoodAuthoritative = null;
  let configParseErrorLogged = false;

  // 跨进程的"上次成功快照"：进程重启后内存快照会丢，若此时配置文件恰好损坏，
  // 单靠内存兜底会退回默认的"启用"。这里把最后一次成功读到的 enabled 落盘（0600），
  // 解析失败时优先回退到它，从而在"管理员已停用 + 配置被写坏 + 重启"下也不会误启用。
  const STATE_FILE = process.env.BROWSER_DESKTOP_STATE_FILE || '/root/.dsh/.browser-desktop-last-state.json';
  function persistLastGood(snapshot) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: snapshot.enabled, savedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch (e) { /* 状态文件写失败不影响主流程 */ }
  }
  function loadPersistedLastGood() {
    try {
      const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof o.enabled === 'boolean') return { enabled: o.enabled };
    } catch (e) { /* 无状态文件或已损坏 */ }
    return null;
  }
  function fallbackSnapshot() {
    return lastGoodAuthoritative || loadPersistedLastGood();
  }

  function readAuthoritativeConfig() {
    let raw;
    try {
      raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        if (!configParseErrorLogged) {
          console.error('[dsh-browser-desktop] 读取权威配置失败，保持上次成功快照:', e.message);
          configParseErrorLogged = true;
        }
      }
      return fallbackSnapshot(); // 不存在 → null（沿用当前状态）；读失败 → 上次成功快照
    }

    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      if (!configParseErrorLogged) {
        console.error('[dsh-browser-desktop] 权威配置解析失败（JSON 损坏），保持上次成功快照而非回退为启用:', e.message);
        configParseErrorLogged = true;
      }
      return fallbackSnapshot();
    }

    configParseErrorLogged = false;
    const d = cfg.desktop || {};
    const snapshot = {
      enabled: d.enabled !== false,
      resolution: (Number(d.width) > 0 && Number(d.height) > 0)
        ? `${Number(d.width)}x${Number(d.height)}` : activeConfig.resolution,
      enableCdp: d.enableCdp !== false,
      cdpPort: Number(d.cdpPort) > 0 ? Number(d.cdpPort) : activeConfig.cdpPort,
      idleTimeoutMinutes: typeof d.idleTimeoutMinutes === 'number' ? d.idleTimeoutMinutes : activeConfig.idleTimeoutMinutes,
      screenshotQuality: d.screenshotQuality || activeConfig.screenshotQuality,
      screenshotDir: typeof d.screenshotDir === 'string' ? d.screenshotDir : activeConfig.screenshotDir,
      enableSidebarTab: !!d.enableSidebarTab,
      vncPath: cfg.vncPath || activeConfig.vncPath
    };
    lastGoodAuthoritative = snapshot;
    persistLastGood(snapshot);
    return snapshot;
  }

  // 刷新权威配置并据其同步工具/提示词的注册状态（同步执行，调用方无需 await）
  function refreshAuthoritativeConfig() {
    const next = readAuthoritativeConfig();
    if (next) activeConfig = { ...activeConfig, ...next };
    // 关键：即使读不到文件（全新容器首次启动、文件尚未生成）也要按当前状态应用，
    // 否则会出现"插件什么都不注册、AI 永久没有浏览器工具"的严重故障。
    applyEnabledState(activeConfig.enabled !== false);
    return activeConfig;
  }

  // 一次性迁移：把旧 DSH 设置文档 browser-desktop 段里的【用户显式设置过】的值搬到网关权威配置
  async function migrateLegacySettingsOnce() {
    try {
      if (legacyMigrated()) return;
      // 当前 DSH 不提供 section API（极老版本）→ 保留待下次，不做迁移也不打标记
      if (!ctx.settings || typeof ctx.settings.section !== 'function') return;
      const legacy = readLegacySection();
      if (!legacy) { markLegacyMigrated(); return; }
      const patch = {};
      let disableDesktop = false;
      if (legacy.enabled === false) disableDesktop = true; // 默认值为 true，出现 false 即用户显式关闭
      if (legacy.screenshotQuality && legacy.screenshotQuality !== 'high') patch.screenshotQuality = legacy.screenshotQuality;
      if (typeof legacy.screenshotDir === 'string' && legacy.screenshotDir.trim()) patch.screenshotDir = legacy.screenshotDir.trim();
      if (legacy.enableSidebarTab === true) patch.enableSidebarTab = true;

      if (Object.keys(patch).length) {
        const r = await callDesktopManager('config', patch);
        console.log('[dsh-browser-desktop] 旧设置已迁移到管理后台权威配置:', JSON.stringify(patch), JSON.stringify(r));
      }
      if (disableDesktop) {
        const r = await callDesktopManager('master', { enabled: false });
        console.log('[dsh-browser-desktop] 旧设置的「已停用」已迁移到管理后台总开关:', JSON.stringify(r));
      }
      markLegacyMigrated();
    } catch (e) {
      console.warn('[dsh-browser-desktop] 旧设置迁移失败(已忽略):', e.message);
    }
  }

  async function navigatePageViaCdp(webSocketDebuggerUrl, targetUrl) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP Page.navigate 超时'));
      }, 4000);

      const ws = new WebSocket(webSocketDebuggerUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 101,
          method: 'Page.navigate',
          params: { url: targetUrl }
        }));
      };
      ws.onmessage = (event) => {
        // P6：只有收到【本次请求 id 的响应】才清超时并结算；
        // 其它 CDP 事件（如 Page.* 通知）不清超时，否则响应一旦丢失 Promise 会永久挂起。
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          return reject(e);
        }
        if (!msg || msg.id !== 101) return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error) return reject(new Error(msg.error.message));
        resolve(msg.result);
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      };
    });
  }

  // 目标 URL 归一化 + 协议白名单：仅允许 http/https，
  // 阻断 file://（读宿主敏感文件）、data:、javascript:、chrome:// 等协议。
  function normalizeTargetUrl(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) throw new Error('URL 不能为空');
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
    const withScheme = hasScheme ? s : `https://${s}`;
    let parsed;
    try { parsed = new URL(withScheme); }
    catch { throw new Error('URL 格式不合法: ' + s.slice(0, 120)); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 协议（已拒绝 ${parsed.protocol}）: ${s.slice(0, 120)}`);
    }
    if (!parsed.hostname) throw new Error('URL 缺少主机名: ' + s.slice(0, 120));
    return parsed.toString();
  }

  async function openInChromium(url, durationMinutes, signal, customResolution, options = {}) {
    const targetUrl = normalizeTargetUrl(url);

    // 优先采用 AI 显式指定的分辨率，未指定时默认使用插件设置中心配置的分辨率 (默认 1920x1080)
    // 仅在调用方显式指定分辨率时才覆盖运行分辨率；否则交给网关沿用当前值（避免整桌重启、丢失标签页）
    const explicitRes = typeof customResolution === 'string' && customResolution.trim() ? customResolution.trim().toLowerCase() : null;
    const parts = explicitRes ? explicitRes.split('x') : [];
    const width = parseInt(parts[0]) || undefined;
    const height = parseInt(parts[1]) || undefined;
    const effectiveRes = explicitRes || activeConfig.resolution || '1920x1080';

    // 如果桌面未运行或需要调整分辨率，自动唤醒启动
    const startRes = await callDesktopManager('start', {
      durationMinutes,
      width,
      height,
      idleTimeoutMinutes: activeConfig.idleTimeoutMinutes,
      enableCdp: activeConfig.enableCdp,
      cdpPort: activeConfig.cdpPort
    });
    if (!startRes || startRes.ok === false) {
      throw new Error(`容器桌面启动失败: ${startRes?.error || '网关无响应'}`);
    }

    let tabId = null;
    let reused = false;

    // 等待 CDP 端口就绪 (若启用 CDP)
    if (activeConfig.enableCdp !== false) {
      let cdpReady = false;
      for (let i = 0; i < 20; i++) {
        try {
          const check = await fetch(`${cdpBase()}/json/version`, { signal });
          if (check.ok) { cdpReady = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }

      if (!cdpReady) {
        throw new Error('CDP 调试端口未就绪，浏览器可能启动失败 (可用 browser_control status 查看桌面状态)');
      }

      const forceNewTab = options.newTab === true;

      if (!forceNewTab) {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal });
          if (listRes.ok) {
            const allTargets = await listRes.json();
            const pages = allTargets.filter(t => t.type === 'page');

            let targetPage = null;
            if (options.tabId) {
              targetPage = pages.find(p => p.id === options.tabId);
            }
            if (!targetPage && pages.length > 0) {
              // 优先复用空白页 (about:blank 或 chrome://newtab/)，其次复用已有页面
              targetPage = pages.find(p => p.url === 'about:blank' || p.url === 'chrome://newtab/') || pages[pages.length - 1];
            }

            if (targetPage && targetPage.webSocketDebuggerUrl) {
              await navigatePageViaCdp(targetPage.webSocketDebuggerUrl, targetUrl);
              tabId = targetPage.id;
              reused = true;
              try {
                await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(tabId)}`, { signal });
              } catch {}
            }
          }
        } catch (navErr) {
          console.warn('[dsh-browser-desktop] 复用标签页导航失败，将降级新建标签页:', navErr.message);
        }
      }

      // 若需要新建标签页或复用导航未成功，调用 CDP 新建标签页
      if (!tabId) {
        const res = await fetch(`${cdpBase()}/json/new?${encodeURIComponent(targetUrl)}`, {
          method: 'PUT',
          signal
        });
        if (res.ok) {
          const page = await res.json();
          tabId = page.id;
          reused = false;
          try { await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(page.id)}`, { signal }); } catch {}
        }
      }

      if (!tabId) {
        throw new Error('未能创建或复用浏览器标签页 (CDP 无可用页面)');
      }
    }

    // 更新心跳时长
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      await callDesktopManager('keepalive', { durationMinutes });
    }

    return {
      url: targetUrl,
      tabId,
      reused,
      resolution: effectiveRes,
      vncUrl: `${vncPath()}/?autoconnect=1&resize=scale&view_only=0&reconnect=1`,
      status: reused ? 'navigated' : 'opened'
    };
  }

  // 双引擎截图实现：支持画质选择 (high 高/原图, medium 中, low 低)、指定 tabId 与自定义保存路径
  async function captureScreenshotDual(savePath, customQuality, targetTabId, sessionCwd = process.cwd()) {
    const qualityLevel = (customQuality || activeConfig.screenshotQuality || 'high').toLowerCase();
    const isHigh = qualityLevel === 'high';
    const isLow = qualityLevel === 'low';

    // 智能路径处理：
    // 优先基于当前会话/项目自身的工作区 sessionCwd 进行解析，坚决避免污染容器外部 /workspace 根目录；
    // 1. 若 AI 传入路径：绝对路径直接使用，相对路径基于当前项目工作区 sessionCwd 解析；
    // 2. 若 AI 未提供 savePath：在当前项目工作区（或配置的子目录）自动生成时间戳唯一文件名，绝不覆盖历史截图；
    // 3. 严格尊重 AI 指定的文件扩展名与路径，不再强制将 .png 改名为 .jpg。
    const projectDir = sessionCwd || process.cwd();
    const resolvedProjectDir = path.resolve(projectDir);

    // 真实路径解析：逐级向上找到第一个已存在的祖先目录，再用 realpath 解析，
    // 从而识破"工作区内符号链接指向工作区外"的越界写法（仅靠字符串前缀比对无法发现）。
    function realParentOf(p) {
      let dir = path.dirname(p);
      for (let i = 0; i < 64; i++) {
        if (fs.existsSync(dir)) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
    }
    const realRoot = (() => { try { return fs.realpathSync(resolvedProjectDir); } catch { return resolvedProjectDir; } })();
    const isWithinWorkspace = (p) => {
      const parent = realParentOf(p);
      return parent === realRoot || parent.startsWith(realRoot + path.sep);
    };

    // screenshotDir 必须落在工作区内，否则忽略该配置（避免把越界目录当作降级写入目标）
    let baseDir = resolvedProjectDir;
    if (activeConfig.screenshotDir && activeConfig.screenshotDir.trim()) {
      const candidate = path.resolve(resolvedProjectDir, activeConfig.screenshotDir.trim());
      if (isWithinWorkspace(candidate)) {
        baseDir = candidate;
      } else {
        console.warn(`[dsh-browser-desktop] screenshotDir 越界，已忽略并回退到工作区根目录: ${activeConfig.screenshotDir}`);
      }
    }

    let targetFile;
    if (typeof savePath === 'string' && savePath.trim()) {
      const trimmed = savePath.trim();
      const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(projectDir, trimmed);

      // 工作区边界沙箱检查：既比对字符串前缀，也比对 realpath（防符号链接逃逸）
      const withinByPath = resolved === resolvedProjectDir || resolved.startsWith(resolvedProjectDir + path.sep);
      if (!withinByPath || !isWithinWorkspace(resolved)) {
        const safeBase = path.basename(trimmed) || `screenshot-${Date.now()}`;
        targetFile = path.resolve(baseDir, safeBase);
      } else {
        targetFile = resolved;
      }

      // 如果没有扩展名，根据画质自动补齐合适后缀
      if (!path.extname(targetFile)) {
        targetFile += (isHigh ? '.png' : '.jpg');
      }
    } else {
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      targetFile = path.resolve(baseDir, `screenshot-${timestamp}.${isHigh ? 'png' : 'jpg'}`);
    }

    const ext = path.extname(targetFile).toLowerCase();
    const isJpeg = ext === '.jpg' || ext === '.jpeg';
    const captureFormat = isJpeg ? 'jpeg' : 'png';

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    // 唤醒桌面运行
    const startRes = await callDesktopManager('start', {});
    if (!startRes || startRes.ok === false) {
      throw new Error(`容器桌面启动失败: ${startRes?.error || '网关无响应'}`);
    }

    // 1. 若启用了 CDP，优先尝试 CDP 网页级截图
    if (activeConfig.enableCdp !== false) {
      try {
        const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(1500) });
        if (listRes.ok) {
          const targets = await listRes.json();
          const pages = targets.filter(t => t.type === 'page');
          let page = null;
          if (targetTabId) {
            page = pages.find(p => p.id === targetTabId);
          }
          if (!page) {
            page = pages[0] || targets[0];
          }

          if (page && page.id) {
            try { await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(page.id)}`, { signal: AbortSignal.timeout(5000) }); } catch {}
          }

          if (page && page.webSocketDebuggerUrl) {
            const wsResult = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                try { ws.close(); } catch {}
                reject(new Error('CDP 截图超时'));
              }, 5000);

              const ws = new WebSocket(page.webSocketDebuggerUrl);
              ws.onopen = () => {
                const captureParams = {
                  format: captureFormat
                };
                if (captureFormat === 'jpeg') {
                  captureParams.quality = isLow ? 40 : (isHigh ? 95 : 80);
                }
                ws.send(JSON.stringify({
                  id: 200,
                  method: 'Page.captureScreenshot',
                  params: captureParams
                }));
              };
              ws.onmessage = (event) => {
                // P6：同上 —— 只认本次请求 id（200）的响应，避免误清超时导致永久挂起
                let msg;
                try { msg = JSON.parse(event.data); } catch (e) {
                  clearTimeout(timer);
                  try { ws.close(); } catch {}
                  return reject(e);
                }
                if (!msg || msg.id !== 200) return;
                clearTimeout(timer);
                try { ws.close(); } catch {}
                if (msg.error) return reject(new Error(msg.error.message));
                try {
                  const buf = Buffer.from(msg.result.data, 'base64');
                  fs.writeFileSync(targetFile, buf);
                  resolve({
                    path: targetFile,
                    bytes: buf.length,
                    title: page.title || '',
                    url: page.url || '',
                    quality: qualityLevel,
                    engine: `CDP (${captureFormat === 'png' ? 'PNG无损原图' : 'JPEG质量' + (isLow ? '40' : (isHigh ? '95' : '80'))})`,
                    status: 'captured'
                  });
                } catch (e) { reject(e); }
              };
              ws.onerror = (err) => {
                clearTimeout(timer);
                try { ws.close(); } catch {}
                reject(err);
              };
            });
            return wsResult;
          }
        }
      } catch (err) {
        console.warn('[dsh-browser-desktop] CDP 暂不可达，自动回退到 X11 原生截屏引擎:', err.message);
      }
    }

    // 2. 当关闭 CDP 或 CDP 未就绪时：通过 X11 原生截屏引擎 (scrot) 直接抓取 :99 虚拟屏幕
    const display = process.env.DISPLAY || ':99';
    const { spawnSync } = await import('node:child_process');
    const scrotArgs = captureFormat === 'png'
      ? ['-z', targetFile]
      : ['-q', isLow ? '40' : (isHigh ? '95' : '80'), targetFile];
    const scrotRes = spawnSync('scrot', scrotArgs, {
      env: { ...process.env, DISPLAY: display }
    });

    if (scrotRes.status !== 0 || !fs.existsSync(targetFile)) {
      throw new Error(`截屏失败: ${scrotRes.stderr?.toString() || '无法保存图像'}`);
    }

    const stat = fs.statSync(targetFile);
    return {
      path: targetFile,
      bytes: stat.size,
      title: 'Container Desktop Screen',
      url: 'x11://display' + display,
      quality: qualityLevel,
      engine: `X11 scrot (${captureFormat === 'png' ? 'PNG无损原图' : 'JPEG质量' + (isLow ? '40' : (isHigh ? '95' : '80'))})`,
      status: 'captured'
    };
  }

  // 工具定义：browser_open (打开网页，支持 AI 决定分辨率、智能复用/新开标签页)
  const browserOpenDef = {
    name: 'browser_open',
    description: '在容器内置的 Chromium 图形浏览器中打开指定网页。默认优先智能复用当前空白或活跃标签页以节约容器内存（可通过 newTab: true 显式新开标签页）。支持 AI 自主决定分辨率或工作时长。返回当前标签页的 tabId。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的网页 URL（例如 https://github.com）'
        },
        newTab: {
          type: 'boolean',
          description: '可选：是否在新标签页中打开（默认 false，优先复用当前空白或已有标签页导航，避免内存累积；需要多标签并存对比时传 true）。'
        },
        tabId: {
          type: 'string',
          description: '可选：指定要复用或导航的已有标签页 ID。留空且 newTab=false 时默认复用当前工作标签页。'
        },
        resolution: {
          type: 'string',
          description: '可选：指定当前网页浏览的分辨率（如 "1920x1080", "1280x720", "1440x900", "2560x1440"）。未传时默认使用插件设置中心配置的参数 (默认 1920x1080)。'
        },
        durationMinutes: {
          type: 'number',
          description: '可选：指定允许浏览器工作并保持活跃的时长(分钟)，到期后将自动休眠以节约资源。留空则按默认空闲策略'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          tabId: { type: 'string' },
          reused: { type: 'boolean' },
          resolution: { type: 'string' },
          vncUrl: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['url', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已在容器浏览器中打开 ${value.url} (标签页ID: ${value.tabId || '未知'}, ${value.reused ? '复用已有标签页' : '新建标签页'}, 分辨率: ${value.resolution || '默认'})，可通过桌面 VNC 查看实时画面。`
      }]
    },
    async execute(args, exec) {
      // 调用前读一次本地权威配置（同步、零网络），确保「已彻底停用」时立即拒绝
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        throw new Error('容器图形浏览器桌面已在管理后台被彻底停用');
      }
      if (!args || typeof args.url !== 'string') {
        throw new Error('url 参数必须是非空字符串');
      }
      return openInChromium(args.url.trim(), args.durationMinutes, exec.signal, args.resolution, {
        newTab: args.newTab === true,
        tabId: args.tabId
      });
    }
  };

  // 工具定义：browser_screenshot (支持 AI 自主指定路径、画质及目标标签页)
  const browserScreenshotDef = {
    name: 'browser_screenshot',
    description: '对容器内的 Chromium 浏览器或当前桌面进行实时截屏。支持 AI 传入自定义保存路径 savePath（相对工作区或绝对路径），未传时自动在当前工作区生成带时间戳的唯一文件名（避免覆盖历史截图）。支持选择画质（high 高画质无损原图 / medium 中画质 / low 低画质），以及指定截取特定 tabId。',
    parameters: {
      type: 'object',
      properties: {
        savePath: {
          type: 'string',
          description: '可选：截图保存的文件路径（强烈推荐由 AI 传入有业务含义的路径，支持绝对路径或相对当前会话/项目工作区的相对路径，如 "screenshot.png", "doc/preview-login.png"）。若留空，则自动在当前会话/项目自己的文件夹中生成带时间戳的唯一文件名（如 screenshot-20260906120000.png），绝不覆盖历史截图。'
        },
        tabId: {
          type: 'string',
          description: '可选：指定要截屏的标签页 ID。未传时默认截取当前激活的前台标签页或桌面。'
        },
        quality: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: '可选：截图画质选择。可选 "high" (高画质/无损原图，默认), "medium" (中画质/体积平衡), "low" (低画质/极致压缩)。未传时默认采用插件设置所配置的默认画质。'
        }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'number' },
          quality: { type: 'string' },
          engine: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['path', 'bytes', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已完成页面截图 (保存至: \`${value.path}\`, 大小: ${value.bytes} 字节, 画质: ${value.quality || '默认'}, 引擎: ${value.engine || '默认'})`
      }]
    },
    async execute(args, exec) {
      // 调用前读一次本地权威配置（同步、零网络），确保「已彻底停用」时立即拒绝
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        throw new Error('容器图形浏览器桌面已在管理后台被彻底停用');
      }
      const rawPath = typeof args?.savePath === 'string' ? args.savePath.trim() : null;
      const sessionCwd = exec?.agent?.session?.header?.cwd || process.cwd();
      return captureScreenshotDual(rawPath, args?.quality, args?.tabId, sessionCwd);
    }
  };

  // 工具定义：browser_control (供 AI 显式启停、调整分辨率、查询、关闭标签页)
  const browserControlDef = {
    name: 'browser_control',
    description: '控制容器图形浏览器的运行状态及标签页生命周期：包括关闭指定标签页(close_tab)、关闭所有页面重置为空白页(close_all_tabs)、查询标签页列表(tabs)、启动唤醒(start)、停止休眠(stop)、重启(restart)与状态查询(status)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['close_tab', 'close_all_tabs', 'tabs', 'start', 'stop', 'restart', 'status'],
          description: '要执行的操作：close_tab(关闭指定或当前标签页), close_all_tabs(关闭所有标签页并重置为空白页), tabs(查询当前所有标签页列表), start(启动/唤醒), stop(停止休眠整个桌面), restart(重启桌面), status(查询桌面运行状态)'
        },
        tabId: {
          type: 'string',
          description: '当 action 为 close_tab 时可选传入要关闭的标签页 ID。若未提供则默认关闭当前最新或活跃的标签页。'
        },
        resolution: {
          type: 'string',
          description: '可选：设置启动或重启的分辨率（如 "1920x1080", "1280x720"）。未传时默认采用插件设置配置的分辨率。'
        },
        durationMinutes: {
          type: 'number',
          description: '启动或保持活跃的工作时长(分钟)，到期后自动休眠'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value)
      }]
    },
    async execute(args) {
      // 调用前读一次本地权威配置（同步、零网络），确保「已彻底停用」时立即拒绝
      refreshAuthoritativeConfig();
      if (activeConfig.enabled === false) {
        throw new Error('容器图形浏览器桌面已在管理后台被彻底停用');
      }
      // 标签页查询与管理动作
      if (args.action === 'tabs') {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(2000) });
          if (listRes.ok) {
            const allTargets = await listRes.json();
            const pages = allTargets.filter(t => t.type === 'page').map(p => ({
              id: p.id,
              title: p.title,
              url: p.url
            }));
            return { ok: true, tabs: pages, count: pages.length };
          }
        } catch (err) {
          return { ok: false, error: '获取标签页列表失败或 CDP 暂不可达: ' + err.message };
        }
        return { ok: false, error: 'CDP 服务未返回正常响应' };
      }

      if (args.action === 'close_tab') {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(2000) });
          if (!listRes.ok) return { ok: false, error: 'CDP 服务不可达' };
          const allTargets = await listRes.json();
          const pages = allTargets.filter(t => t.type === 'page');
          if (pages.length === 0) return { ok: true, message: '当前没有打开的网页标签页' };

          let targetToClose = null;
          if (args.tabId) {
            targetToClose = pages.find(p => p.id === args.tabId);
            if (!targetToClose) return { ok: false, error: `未找到 ID 为 ${args.tabId} 的标签页` };
          } else {
            // 优先关闭非 about:blank 标签页，若都是空白页则关闭最后一个
            targetToClose = pages.find(p => p.url !== 'about:blank' && p.url !== 'chrome://newtab/') || pages[pages.length - 1];
          }

          // 安全兜底：如果只剩这一个标签页，先预创一个空白页，防止 Chromium 进程因所有 Tab 关闭而退出
          if (pages.length <= 1) {
            try {
              await fetch(`${cdpBase()}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
            } catch {}
          }

          const closeRes = await fetch(`${cdpBase()}/json/close/${encodeURIComponent(targetToClose.id)}`, { signal: AbortSignal.timeout(5000) });
          return {
            ok: closeRes.ok,
            closedTabId: targetToClose.id,
            closedUrl: targetToClose.url,
            status: closeRes.ok ? 'closed' : 'failed'
          };
        } catch (err) {
          return { ok: false, error: '关闭标签页异常: ' + err.message };
        }
      }

      if (args.action === 'close_all_tabs') {
        try {
          const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(2000) });
          if (!listRes.ok) return { ok: false, error: 'CDP 服务不可达' };
          const allTargets = await listRes.json();
          const pages = allTargets.filter(t => t.type === 'page');

          // 先新建一个干净的 about:blank。
          // P7：这一步【必须成功】——若失败就直接中止，绝不继续关闭全部页面，
          //      否则 Chromium 会因"零标签页"而退出，整桌都要重新拉起（代价远高于报错）。
          let blankId = null;
          try {
            const blankRes = await fetch(`${cdpBase()}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(4000) });
            if (blankRes.ok) {
              const blankPage = await blankRes.json();
              blankId = blankPage && blankPage.id;
              if (blankId) await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(blankId)}`, { signal: AbortSignal.timeout(3000) });
            }
          } catch (e) {
            return { ok: false, error: '预建空白页失败，已中止关闭操作（避免浏览器无标签页退出）: ' + e.message };
          }
          if (!blankId) {
            return { ok: false, error: '预建空白页失败（CDP 未返回新页面 id），已中止关闭操作以免浏览器退出' };
          }

          let closedCount = 0;
          for (const p of pages) {
            if (p.id !== blankId) {
              try {
                await fetch(`${cdpBase()}/json/close/${encodeURIComponent(p.id)}`, { signal: AbortSignal.timeout(3000) });
                closedCount++;
              } catch {}
            }
          }
          return {
            ok: true,
            closedCount,
            resetTo: 'about:blank'
          };
        } catch (err) {
          return { ok: false, error: '关闭全部标签页异常: ' + err.message };
        }
      }

      // 桌面管理动作：仅在 AI 显式指定分辨率时才覆盖运行分辨率（否则沿用当前值，避免误重启整桌）
      const bcRes = (typeof args.resolution === 'string' && args.resolution.trim()) ? args.resolution.trim().toLowerCase() : null;
      const parts = bcRes ? bcRes.split('x') : [];
      const width = parseInt(parts[0]) || undefined;
      const height = parseInt(parts[1]) || undefined;

      if (args.action === 'start') {
        return callDesktopManager('start', { durationMinutes: args.durationMinutes, width, height, enableCdp: activeConfig.enableCdp, cdpPort: activeConfig.cdpPort });
      }
      if (args.action === 'stop') {
        return callDesktopManager('stop');
      }
      if (args.action === 'restart') {
        return callDesktopManager('restart', { durationMinutes: args.durationMinutes, width, height });
      }
      return callDesktopManager('status');
    }
  };

  // ── enabled 主开关：工具 / 提示词的可注销注册 ──────────────────
  const promptSectionDef = {
    name: 'tool:browser_tools',
    order: 110,
    text: 'When you need to view or interact with a webpage, call browser_open (by default it reuses or navigates the active tab to save container memory; pass newTab: true only when you explicitly need multiple tabs open side-by-side; returns tabId). You can call browser_screenshot to capture a screenshot: you can pass your own savePath (supports relative or absolute path, e.g. "screenshot.png" or "doc/preview.png"; if omitted, a unique timestamped file is auto-generated in the current project workspace so previous captures are never overwritten), tabId (optional, targets a specific tab), and quality (high, medium, low). When done with a specific webpage task, call browser_control with action: "close_tab" (optionally specifying tabId) to close that tab, or action: "close_all_tabs" to reset to blank. Call browser_control with action: "stop" only when all browser tasks are completely finished and the entire desktop should be shut down.'
  };

  function registerTools() {
    if (registeredTools.length) return;
    // ctx.tools.register() 返回注销该工具的 disposer，据此支持运行中动态启停
    const added = [];
    try {
      for (const def of [browserOpenDef, browserScreenshotDef, browserControlDef]) {
        added.push(ctx.tools.register(def));
      }
    } catch (e) {
      // 部分注册失败时回滚，保持"要么全注册、要么全没有"的一致性
      for (const d of added) { try { d(); } catch {} }
      throw e;
    }
    registeredTools.push(...added);
    console.log('[dsh-browser-desktop] 已注册 3 个浏览器工具 (browser_open/browser_screenshot/browser_control)');
  }

  function unregisterTools() {
    for (const dispose of registeredTools.splice(0)) {
      try { dispose(); } catch (e) { console.warn('[dsh-browser-desktop] 注销工具失败:', e.message); }
    }
  }

  function registerPrompt() {
    if (registeredPrompt) return;
    // ctx.systemPrompt.section() 返回 Cordis effect disposer，据此支持运行中移除注入
    registeredPrompt = ctx.systemPrompt.section(promptSectionDef);
    console.log('[dsh-browser-desktop] 已注入浏览器系统提示词段 (tool:browser_tools)');
  }

  function unregisterPrompt() {
    if (!registeredPrompt) return;
    try { registeredPrompt(); } catch (e) { console.warn('[dsh-browser-desktop] 移除提示词段失败:', e.message); }
    registeredPrompt = null;
    console.log('[dsh-browser-desktop] 已移除浏览器系统提示词段 (tool:browser_tools)');
  }

  // P2：注册失败后的**有限次退避重试**。
  // 原先失败后只把 enabledState 置 null 等"下一次同步"，而同步入口只在三个工具的
  // execute() 里 —— 工具压根没注册就永远调不到，等于永久僵死。这里用定时器自己重试。
  let retryTimer = null;
  let retryCount = 0;
  const MAX_REGISTER_RETRIES = 5;
  const REGISTER_RETRY_BASE_MS = 2000;

  function clearRegisterRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryCount = 0;
  }

  function scheduleRegisterRetry() {
    if (retryTimer) return;
    if (retryCount >= MAX_REGISTER_RETRIES) {
      console.error(`[dsh-browser-desktop] 工具注册连续失败 ${MAX_REGISTER_RETRIES} 次，停止重试（等待下次配置变更/重启）`);
      return;
    }
    const delay = REGISTER_RETRY_BASE_MS * Math.pow(2, retryCount);
    retryCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      try {
        if (enabledState === true) return;
        refreshAuthoritativeConfig(); // 内部会再次尝试 applyEnabledState
        if (enabledState !== true && activeConfig.enabled !== false) scheduleRegisterRetry();
      } catch (e) {
        console.error('[dsh-browser-desktop] 注册重试异常:', e && e.message ? e.message : e);
        scheduleRegisterRetry();
      }
    }, delay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    console.warn(`[dsh-browser-desktop] 将在 ${Math.round(delay / 1000)}s 后重试注册浏览器工具（第 ${retryCount}/${MAX_REGISTER_RETRIES} 次）`);
  }

  // enabled 状态机：一次切换同时处理「工具注册 + 提示词注入 + 桌面运行」三件事。
  // 关键：注册失败时【不置位】，并安排退避重试，避免"状态已启用但工具其实没注册"的僵死。
  function applyEnabledState(enabled) {
    const next = enabled !== false;
    if (next === enabledState) return;
    if (next) {
      try {
        registerTools();
        registerPrompt();
        enabledState = true;
        clearRegisterRetry();
      } catch (e) {
        console.error('[dsh-browser-desktop] 注册工具/提示词失败（将自动重试）:', e && e.message ? e.message : e);
        enabledState = null;
        scheduleRegisterRetry();
      }
    } else {
      clearRegisterRetry();
      unregisterTools();
      unregisterPrompt();
      enabledState = false;
      // 关闭浏览器：停掉正在运行的虚拟桌面，释放 CPU/内存
      callDesktopManager('stop')
        .then((r) => console.log('[dsh-browser-desktop] 插件已禁用，桌面停止结果:', JSON.stringify(r)))
        .catch(() => {});
      console.log('[dsh-browser-desktop] 插件已禁用：工具已注销、提示词已移除、桌面已停止');
    }
  }

  // 启动时先按本地权威配置决定：挂/不挂 AI 工具与提示词（因此重启后状态即准确）
  refreshAuthoritativeConfig();
  console.log(`[dsh-browser-desktop] 权威配置已加载: enabled=${activeConfig.enabled !== false}, resolution=${activeConfig.resolution}`);

  // 一次性旧值迁移（仅此一次，之后 DSH 设置命名空间不再生效）
  migrateLegacySettingsOnce().catch((e) => console.warn('[dsh-browser-desktop] 旧设置迁移失败(已忽略):', e.message));

  // 插件被卸载/重载时清理注册，避免残留工具与提示词
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      clearRegisterRetry();
      unregisterTools();
      unregisterPrompt();
      enabledState = null;
    });
  }
}
