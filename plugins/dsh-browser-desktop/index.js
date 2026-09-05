import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-browser-desktop';
export const inject = ['tools', 'systemPrompt', 'settings'];

// 插件配置 Schema (在 DSH 设置中心 -> 插件配置页面中完整呈现，允许用户自定义)
export const Config = z.object({
  enabled: z.boolean().default(true).description('是否启用容器图形浏览器桌面'),
  resolution: z.string().default('1920x1080').description('虚拟桌面默认分辨率 (格式如 1920x1080, 1440x900, 1280x720)'),
  screenshotQuality: z.union([z.const('high'), z.const('medium'), z.const('low')]).default('high').description('截图工具默认画质：high (高画质/无损原图，默认), medium (中画质/体积平衡), low (低画质/极致压缩)'),
  idleTimeoutMinutes: z.number().default(30).description('浏览器空闲休眠时间 (分钟，0为不休眠始终保持运行)'),
  enableCdp: z.boolean().default(true).description('是否启用 Chromium CDP 远程调试能力'),
  cdpPort: z.number().default(9222).description('Chromium CDP 远程调试端口 (默认 9222)'),
  vncPath: z.string().default('/vnc').description('VNC 桌面访问相对路径')
});

export function apply(ctx, config = {}) {
  // 实时配置状态，初始由系统注入，随设置中心热更新动态刷新
  let activeConfig = {
    resolution: '1920x1080',
    screenshotQuality: 'high',
    idleTimeoutMinutes: 30,
    enableCdp: true,
    cdpPort: 9222,
    vncPath: '/vnc',
    ...config
  };

  const cdpPort = () => activeConfig.cdpPort || 9222;
  const cdpBase = () => `http://127.0.0.1:${cdpPort()}`;
  const vncPath = () => activeConfig.vncPath || '/vnc';

  // 内部网关管理接口基地址
  const gatewayControlUrl = `http://127.0.0.1:${process.env.PROXY_PORT || 3080}/__internal/desktop`;

  async function callDesktopManager(endpoint, body = {}) {
    try {
      const res = await fetch(`${gatewayControlUrl}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // 1. 注册进入 DSH 官方设置中心 (Settings -> Plugins 页面直接展示配置卡片，设置内容作为 AI 调用默认参数)
  if (ctx.settings) {
    try {
      const scope = ctx.settings.register('browser-desktop', Config, { base: config });
      const current = scope.get();
      if (current) {
        activeConfig = { ...activeConfig, ...current };
      }
      scope.watch((updated) => {
        console.log('[dsh-browser-desktop] 收到 DSH 设置中心更新:', updated);
        activeConfig = { ...activeConfig, ...updated };
        const resParts = (updated.resolution || '1920x1080').toLowerCase().split('x');
        callDesktopManager('keepalive', {
          durationMinutes: updated.idleTimeoutMinutes,
          width: parseInt(resParts[0]) || 1920,
          height: parseInt(resParts[1]) || 1080,
          enableCdp: updated.enableCdp,
          cdpPort: updated.cdpPort
        }).catch(() => {});
      });
    } catch (e) {
      console.warn('[dsh-browser-desktop] 注册 settings namespace 警告:', e.message);
    }
  }

  async function openInChromium(url, durationMinutes, signal, customResolution) {
    const targetUrl = url.includes('://') ? url : `https://${url}`;

    // 优先采用 AI 显式指定的分辨率，未指定时默认使用插件设置中心配置的分辨率 (默认 1920x1080)
    const targetRes = (customResolution || activeConfig.resolution || '1920x1080').toLowerCase();
    const parts = targetRes.split('x');
    const width = parseInt(parts[0]) || 1920;
    const height = parseInt(parts[1]) || 1080;

    // 如果桌面未运行或需要调整分辨率，自动唤醒启动
    await callDesktopManager('start', {
      durationMinutes,
      width,
      height,
      idleTimeoutMinutes: activeConfig.idleTimeoutMinutes
    });

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

      if (cdpReady) {
        // 调用 CDP 打开标签页
        const res = await fetch(`${cdpBase()}/json/new?${encodeURIComponent(targetUrl)}`, {
          method: 'PUT',
          signal
        });
        if (res.ok) {
          const page = await res.json();
          try { await fetch(`${cdpBase()}/json/activate/${encodeURIComponent(page.id)}`, { signal }); } catch {}
        }
      }
    }

    // 更新心跳时长
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      await callDesktopManager('keepalive', { durationMinutes });
    }

    return {
      url: targetUrl,
      resolution: `${width}x${height}`,
      vncUrl: `${vncPath()}/?autoconnect=1&resize=scale&view_only=0&reconnect=1`,
      status: 'opened'
    };
  }

  // 双引擎截图实现：支持画质选择 (high 高/原图, medium 中, low 低)
  async function captureScreenshotDual(savePath = '/workspace/screenshot.png', customQuality) {
    const qualityLevel = (customQuality || activeConfig.screenshotQuality || 'high').toLowerCase();
    const isHigh = qualityLevel === 'high';
    const isLow = qualityLevel === 'low';

    let targetFile = path.resolve(savePath);
    // 高画质默认输出无损 PNG 原图；中/低画质输出压缩 JPEG 节约存储与传输带宽
    if (!isHigh && targetFile.endsWith('.png')) {
      targetFile = targetFile.replace(/\.png$/i, '.jpg');
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    // 唤醒桌面运行
    await callDesktopManager('start', {});

    // 1. 若启用了 CDP，优先尝试 CDP 网页级截图
    if (activeConfig.enableCdp !== false) {
      try {
        const listRes = await fetch(`${cdpBase()}/json`, { signal: AbortSignal.timeout(1500) });
        if (listRes.ok) {
          const targets = await listRes.json();
          const page = targets.find(t => t.type === 'page') || targets[0];
          if (page && page.webSocketDebuggerUrl) {
            const wsResult = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                try { ws.close(); } catch {}
                reject(new Error('CDP 截图超时'));
              }, 5000);

              const ws = new WebSocket(page.webSocketDebuggerUrl);
              ws.onopen = () => {
                const captureParams = {
                  format: isHigh ? 'png' : 'jpeg'
                };
                if (!isHigh) {
                  captureParams.quality = isLow ? 40 : 80;
                }
                ws.send(JSON.stringify({
                  id: 200,
                  method: 'Page.captureScreenshot',
                  params: captureParams
                }));
              };
              ws.onmessage = (event) => {
                clearTimeout(timer);
                try {
                  const msg = JSON.parse(event.data);
                  if (msg.id === 200) {
                    ws.close();
                    if (msg.error) return reject(new Error(msg.error.message));
                    const buf = Buffer.from(msg.result.data, 'base64');
                    fs.writeFileSync(targetFile, buf);
                    resolve({
                      path: targetFile,
                      bytes: buf.length,
                      title: page.title || '',
                      url: page.url || '',
                      quality: qualityLevel,
                      engine: `CDP (${isHigh ? 'PNG无损原图' : 'JPEG质量' + (isLow ? '40' : '80')})`,
                      status: 'captured'
                    });
                  }
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
    const scrotArgs = isHigh ? ['-z', targetFile] : ['-q', isLow ? '40' : '80', targetFile];
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
      engine: `X11 scrot (${isHigh ? 'PNG无损原图' : 'JPEG质量' + (isLow ? '40' : '80')})`,
      status: 'captured'
    };
  }

  // 1. 注册 browser_open 工具 (打开网页，支持 AI 决定分辨率)
  ctx.tools.register({
    name: 'browser_open',
    description: '在容器内置的 Chromium 图形浏览器中打开指定网页。支持 AI 自主决定分辨率或工作时长。若未传分辨率则默认采用插件设置配置的参数 (默认 1920x1080 1080p)。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的网页 URL（例如 https://github.com）'
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
          resolution: { type: 'string' },
          vncUrl: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['url', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已在容器浏览器中打开 ${value.url} (分辨率: ${value.resolution || '默认'})，可通过桌面 VNC 查看实时画面。`
      }]
    },
    async execute(args, exec) {
      if (!args || typeof args.url !== 'string') {
        throw new Error('url 参数必须是非空字符串');
      }
      return openInChromium(args.url.trim(), args.durationMinutes, exec.signal, args.resolution);
    }
  });

  // 2. 注册 browser_screenshot 工具 (支持 AI 决定截图画质: high/medium/low)
  ctx.tools.register({
    name: 'browser_screenshot',
    description: '对容器内的 Chromium 浏览器或当前桌面进行实时截屏。支持 AI 选择画质（high 高画质原图 / medium 中画质 / low 低画质小体积），未指定时默认采用插件设置所配置的默认参数 (默认 high)。',
    parameters: {
      type: 'object',
      properties: {
        savePath: {
          type: 'string',
          description: '可选：截图保存的绝对路径，默认保存为 /workspace/screenshot.png'
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
        text: `已完成页面截图 (画质: ${value.quality || '默认'}, 引擎: ${value.engine || '默认'})，保存至: ${value.path} (大小: ${value.bytes} 字节)`
      }]
    },
    async execute(args) {
      const target = (args?.savePath || '/workspace/screenshot.png').trim();
      return captureScreenshotDual(target, args?.quality);
    }
  });

  // 3. 注册 browser_control 工具 (供 AI 显式启停、调整分辨率与查询)
  ctx.tools.register({
    name: 'browser_control',
    description: '控制容器图形浏览器的运行状态（启动、停止休眠、重启、查询状态、调整分辨率），或设置保持运行工作的时间。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart', 'status'],
          description: '要执行的操作：start(启动/唤醒), stop(停止/休眠), restart(重启), status(查询运行状态)'
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
      const targetRes = (args.resolution || activeConfig.resolution || '1920x1080').toLowerCase();
      const parts = targetRes.split('x');
      const width = parseInt(parts[0]) || 1920;
      const height = parseInt(parts[1]) || 1080;

      if (args.action === 'start') {
        return callDesktopManager('start', { durationMinutes: args.durationMinutes, width, height });
      }
      if (args.action === 'stop') {
        return callDesktopManager('stop');
      }
      if (args.action === 'restart') {
        return callDesktopManager('restart', { durationMinutes: args.durationMinutes, width, height });
      }
      return callDesktopManager('status');
    }
  });

  ctx.systemPrompt.section({
    name: 'tool:browser_tools',
    order: 110,
    text: 'When you need to view or interact with a webpage, call browser_open (you can specify resolution like "1920x1080" or "1280x720", defaults to 1920x1080). You can call browser_screenshot to capture a screenshot (you can specify quality as "high", "medium", or "low", defaults to high). If resolution or quality are omitted, they automatically use the user\'s plugin configuration settings. You can call browser_control to stop the browser when tasks are complete.'
  });
}
