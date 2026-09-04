import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-browser-desktop';
export const inject = ['tools', 'systemPrompt', 'settings'];

// 插件配置 Schema (在 DSH 设置中心 -> 插件配置页面中完整呈现，允许用户自定义)
export const Config = z.object({
  enabled: z.boolean().default(true).description('是否启用容器图形浏览器桌面'),
  resolution: z.string().default('1440x900').description('虚拟桌面分辨率 (格式如 1440x900, 1920x1080)'),
  idleTimeoutMinutes: z.number().default(30).description('浏览器空闲休眠时间 (分钟，0为不休眠始终保持运行)'),
  enableCdp: z.boolean().default(true).description('是否启用 Chromium CDP 远程调试能力'),
  cdpPort: z.number().default(9222).description('Chromium CDP 远程调试端口 (默认 9222)'),
  vncPath: z.string().default('/vnc').description('VNC 桌面访问相对路径')
});

export function apply(ctx, config = {}) {
  const cdpPort = config.cdpPort || 9222;
  const cdpBase = `http://127.0.0.1:${cdpPort}`;
  const vncPath = config.vncPath || '/vnc';

  // 内部网关管理接口基地址
  const gatewayControlUrl = 'http://127.0.0.1:3080/__internal/desktop';

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

  // 1. 注册进入 DSH 官方设置中心 (Settings -> Plugins 页面直接展示配置卡片)
  if (ctx.settings) {
    try {
      const scope = ctx.settings.register('browser-desktop', Config, { base: config });
      scope.watch((updated) => {
        console.log('[dsh-browser-desktop] 收到 DSH 设置中心更新:', updated);
        callDesktopManager('keepalive', {
          durationMinutes: updated.idleTimeoutMinutes,
          width: updated.resolution ? parseInt(updated.resolution.split('x')[0]) : undefined,
          height: updated.resolution ? parseInt(updated.resolution.split('x')[1]) : undefined,
          enableCdp: updated.enableCdp,
          cdpPort: updated.cdpPort
        }).catch(() => {});
      });
    } catch (e) {
      console.warn('[dsh-browser-desktop] 注册 settings namespace 警告:', e.message);
    }
  }

  async function openInChromium(url, durationMinutes, signal) {
    const targetUrl = url.includes('://') ? url : `https://${url}`;

    // 如果桌面未运行，自动唤醒启动并传递工作时长
    await callDesktopManager('start', {
      durationMinutes,
      width: config.resolution ? parseInt(config.resolution.split('x')[0]) : undefined,
      height: config.resolution ? parseInt(config.resolution.split('x')[1]) : undefined,
      idleTimeoutMinutes: config.idleTimeoutMinutes
    });

    // 等待 CDP 端口就绪 (若启用 CDP)
    if (config.enableCdp !== false) {
      let cdpReady = false;
      for (let i = 0; i < 20; i++) {
        try {
          const check = await fetch(`${cdpBase}/json/version`, { signal });
          if (check.ok) { cdpReady = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }

      if (cdpReady) {
        // 调用 CDP 打开标签页
        const res = await fetch(`${cdpBase}/json/new?${encodeURIComponent(targetUrl)}`, {
          method: 'PUT',
          signal
        });
        if (res.ok) {
          const page = await res.json();
          try { await fetch(`${cdpBase}/json/activate/${encodeURIComponent(page.id)}`, { signal }); } catch {}
        }
      }
    }

    // 更新心跳时长
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      await callDesktopManager('keepalive', { durationMinutes });
    }

    return {
      url: targetUrl,
      vncUrl: `${vncPath}/?autoconnect=1&resize=scale&view_only=0&reconnect=1`,
      status: 'opened'
    };
  }

  // 双引擎截图实现：CDP 打开时优先走 CDP 页面级截屏；关闭 CDP 时自动无缝走 X11 scrot 原生抓屏引擎
  async function captureScreenshotDual(savePath = '/workspace/screenshot.png') {
    const targetFile = path.resolve(savePath);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    // 唤醒桌面运行
    await callDesktopManager('start', {});

    // 1. 若启用了 CDP，优先尝试 CDP 网页级截图
    if (config.enableCdp !== false) {
      try {
        const listRes = await fetch(`${cdpBase}/json`, { signal: AbortSignal.timeout(1500) });
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
                ws.send(JSON.stringify({
                  id: 200,
                  method: 'Page.captureScreenshot',
                  params: { format: 'png' }
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
                      engine: 'CDP',
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
    const scrotRes = spawnSync('scrot', ['-z', targetFile], {
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
      engine: 'X11 (scrot - CDP已关闭/免依赖模式)',
      status: 'captured'
    };
  }

  // 1. 注册 browser_open 工具 (打开网页)
  ctx.tools.register({
    name: 'browser_open',
    description: '在容器内置的 Chromium 图形浏览器中打开指定网页。若浏览器处于休眠状态将自动唤醒启动。允许指定保持工作时长。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的网页 URL（例如 https://github.com）'
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
          vncUrl: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['url', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已在容器浏览器中打开 ${value.url}，可通过桌面 VNC 查看实时画面。`
      }]
    },
    async execute(args, exec) {
      if (!args || typeof args.url !== 'string') {
        throw new Error('url 参数必须是非空字符串');
      }
      return openInChromium(args.url.trim(), args.durationMinutes, exec.signal);
    }
  });

  // 2. 注册 browser_screenshot 工具 (双引擎：开启/关闭 CDP 均百分之百有效)
  ctx.tools.register({
    name: 'browser_screenshot',
    description: '对容器内的 Chromium 浏览器或当前桌面进行实时截屏，生成 PNG 图像文件保存至工作区。无论 CDP 调试端口是否开启均有效。',
    parameters: {
      type: 'object',
      properties: {
        savePath: {
          type: 'string',
          description: '可选：截图保存的绝对路径，默认保存为 /workspace/screenshot.png'
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
          engine: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['path', 'bytes', 'status'],
        additionalProperties: true
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已完成页面截图 (引擎: ${value.engine || '默认'})，保存至: ${value.path} (大小: ${value.bytes} 字节)`
      }]
    },
    async execute(args) {
      const target = (args?.savePath || '/workspace/screenshot.png').trim();
      return captureScreenshotDual(target);
    }
  });

  // 3. 注册 browser_control 工具 (供 AI 显式启停与查询)
  ctx.tools.register({
    name: 'browser_control',
    description: '控制容器图形浏览器的运行状态（启动、停止休眠、重启、查询状态），或设置保持运行工作的时间。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart', 'status'],
          description: '要执行的操作：start(启动/唤醒), stop(停止/休眠), restart(重启), status(查询运行状态)'
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
      if (args.action === 'start') {
        return callDesktopManager('start', { durationMinutes: args.durationMinutes });
      }
      if (args.action === 'stop') {
        return callDesktopManager('stop');
      }
      if (args.action === 'restart') {
        return callDesktopManager('restart', { durationMinutes: args.durationMinutes });
      }
      return callDesktopManager('status');
    }
  });

  ctx.systemPrompt.section({
    name: 'tool:browser_tools',
    order: 110,
    text: 'When you need to view or interact with a webpage, call browser_open. You can call browser_screenshot to capture a PNG screenshot of the current browser page (works whether CDP is enabled or disabled) to inspect rendering or visually analyze elements. You can call browser_control to stop the browser when tasks are complete.'
  });
}
