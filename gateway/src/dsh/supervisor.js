'use strict';
/**
 * supervisor.js — DSH 子进程生命周期管理、端口清理、日志脱敏、令牌捕获与会话 Cookie 换取。
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const paths = require('../core/paths');
const { detectCrashingPlugin } = require('./crash-detector');

function getDshPort() {
  return Number(process.env.DSH_PORT) || 3079;
}

function redactLog(data) {
  return String(Buffer.isBuffer(data) ? data.toString('utf8') : data)
    .replace(/([?&]token=)[A-Za-z0-9._~-]+/gi, '$1<redacted>');
}

function killPortProcess(port) {
  const proxyPort = Number(process.env.PROXY_PORT) || 3080;
  if (Number(port) === proxyPort) {
    console.warn(`[dsh-supervisor] 跳过端口清理：目标端口 ${port} 与网关端口相同`);
    return;
  }
  try {
    spawnSync('fuser', ['-k', '-9', `${port}/tcp`], { stdio: 'ignore' });
  } catch {}
  try {
    const res = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        if (!/dsh\s+web(\s|$)/.test(line)) continue;
        if (!line.includes(String(port))) continue;
        const m = line.trim().match(/^(\d+)/);
        if (m) {
          const pid = Number(m[1]);
          if (pid !== process.pid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      }
    }
  } catch {}
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

async function ensurePortReleased(port, timeoutMs = 3500) {
  killPortProcess(port);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let inUse = false;
    try {
      const res = spawnSync('ss', ['-tlpn'], { encoding: 'utf8' });
      if (res.stdout && res.stdout.includes(`:${port}`)) {
        inUse = true;
      }
    } catch {}
    if (!inUse) {
      inUse = await isPortInUse(port);
    }
    if (!inUse) return true;
    killPortProcess(port);
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function exchangeSessionCookie(manager, token = manager.launchToken) {
  if (!token) return '';
  const port = getDshPort();
  const targetUrl = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: { Host: `127.0.0.1:${port}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookieHeader = res.headers.get('set-cookie') || '';
    const allCookies = setCookies.length > 0 ? setCookies : (cookieHeader ? [cookieHeader] : []);

    for (const sc of allCookies) {
      if (sc && sc.includes('dsh-auth-')) {
        const cookiePair = sc.split(';')[0].trim();
        manager.upstreamCookie = cookiePair;
        return cookiePair;
      }
    }
  } catch (err) {
    console.warn('[dsh-supervisor] 换取会话 Cookie 失败:', err.message);
  }
  return manager.upstreamCookie;
}

async function waitReady(manager, timeoutMs = 60000, onProbeProgress) {
  const port = getDshPort();
  const start = Date.now();
  const deadline = start + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    if (!manager.proc || manager.proc.exitCode !== null || manager.proc.killed) {
      return false;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500 && manager.proc && manager.proc.exitCode === null) {
        return true;
      }
    } catch {}
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    if (typeof onProbeProgress === 'function') {
      try { onProbeProgress({ attempts, elapsedSec }); } catch {}
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

function bootProcess(manager, onProbe) {
  return new Promise((resolve) => {
    Promise.resolve()
      .then(() => bootProcessImpl(manager, onProbe, resolve))
      .catch((err) => {
        console.error('[dsh-supervisor] 启动流程异常:', (err && err.message) || err);
        resolve({ ok: false, error: (err && err.message) || String(err) });
      });
  });
}

async function bootProcessImpl(manager, onProbe, resolve) {
  const dshPort = getDshPort();
  const dshDir = paths.getDshDir();
  const workspace = paths.getWorkspaceDir();
  const webLog = paths.getDshWebLogFile();

  manager.manualStopped = false;
  if (manager.proc && manager.proc.exitCode === null && !manager.proc.killed) {
    return resolve({ ok: true, alreadyRunning: true });
  }
  if (manager.proc) {
    console.warn('[dsh-supervisor] 检测到已退出的僵尸进程引用，清理后继续启动');
    manager.proc = null;
    manager.ready = false;
  }
  manager.stopping = false;
  if (manager.restartTimer) {
    clearTimeout(manager.restartTimer);
    manager.restartTimer = null;
  }

  // 修复 .credentials.yaml 与 .dsh 权限
  try {
    const credPath = path.join(dshDir, '.credentials.yaml');
    if (fs.existsSync(credPath)) {
      fs.chmodSync(credPath, 0o600);
    }
    if (fs.existsSync(dshDir)) {
      fs.chmodSync(dshDir, 0o700);
    }
  } catch (err) {
    console.warn('[dsh-supervisor] 校验/修复凭据文件权限失败:', err.message);
  }

  await ensurePortReleased(dshPort, 4000);
  await new Promise((r) => setTimeout(r, 200));

  try { fs.mkdirSync(workspace, { recursive: true }); } catch {}
  try { fs.mkdirSync(path.dirname(webLog), { recursive: true }); } catch {}

  console.log(`[dsh-supervisor] 启动 DSH 进程 (工作区: ${workspace}, 端口: ${dshPort})...`);
  manager.ready = false;
  manager.upstreamCookie = '';

  const logStream = fs.createWriteStream(webLog, { flags: 'a' });
  logStream.on('error', (e) => console.warn('[dsh-supervisor] DSH 日志写入失败(已忽略):', e.message));

  const env = {
    ...process.env,
    DSH_PORT: String(dshPort),
    PROXY_PORT: String(process.env.PROXY_PORT || 3080),
    NPM_CONFIG_REGISTRY: manager.registry,
    NPM_REGISTRY: manager.registry,
    PNPM_REGISTRY: manager.registry,
    // 显式将子进程 DSH_HOME 收敛至 DSH_DIR（即 $DSH_HOME/.dsh），使官方 resolveDshHome 读取正确的 profiles/web
    DSH_HOME: dshDir
  };
  delete env.NODE_ENV;

  const p = spawn('dsh', ['web', '--port', String(dshPort), '--no-open'], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  manager.proc = p;

  p.stdout.on('data', (d) => {
    const safe = redactLog(d);
    logStream.write(safe);
    process.stdout.write(safe);

    const str = d.toString('utf8');
    const lines = str.split('\n').filter(Boolean);
    for (const l of lines) {
      manager.recentLogs.push(redactLog(l));
      if (manager.recentLogs.length > 80) manager.recentLogs.shift();
    }

    const m = str.match(/token=([A-Za-z0-9._~-]{16,})/i);
    if (m) {
      const token = m[1].trim();
      if (token !== manager.launchToken) {
        manager.launchToken = token;
        manager.upstreamCookie = '';
        exchangeSessionCookie(manager, token).catch(() => {});
      }
    }
  });

  p.stderr.on('data', (d) => {
    const safe = redactLog(d);
    logStream.write(safe);
    process.stderr.write(safe);

    const str = d.toString('utf8');
    const lines = str.split('\n').filter(Boolean);
    for (const l of lines) {
      manager.recentLogs.push(redactLog(l));
      if (manager.recentLogs.length > 80) manager.recentLogs.shift();
    }
  });

  p.on('error', (err) => {
    console.error('[dsh-supervisor] DSH 启动错误:', err.message);
    manager.proc = null;
    manager.ready = false;
    manager.lastExitInfo = { code: -1, sig: err.message, time: Date.now(), logs: manager.recentLogs.slice(-20) };
    resolve({ ok: false, error: err.message });
  });

  p.on('exit', (code, sig) => {
    console.log(`[dsh-supervisor] DSH 已退出 (code=${code}, sig=${sig})`);
    if (code !== 0 && code !== null) {
      manager.lastExitInfo = { code, sig, time: Date.now(), logs: manager.recentLogs.slice(-20) };
    }
    const wasReady = manager.ready;
    if (manager.proc === p) {
      manager.proc = null;
      manager.ready = false;
      manager.upstreamCookie = '';
    }
    if (manager.manualStopped) {
      console.log('[dsh-supervisor] DSH 处于手动停止状态，暂停自动重新拉起');
      return;
    }
    if (!wasReady) return;

    if (!manager.stopping && !manager.installing) {
      const now = Date.now();
      const CRASH_WINDOW_MS = 120000;
      const MAX_CRASHES = 5;

      if (manager.startTime && now - manager.startTime > CRASH_WINDOW_MS) {
        manager.crashWindow = [];
      }
      manager.crashWindow = (manager.crashWindow || []).filter((t) => now - t < CRASH_WINDOW_MS);
      manager.crashWindow.push(now);
      manager.lastCrashTime = now;
      const crashes = manager.crashWindow.length;

      if (crashes > MAX_CRASHES) {
        console.error(`[dsh-supervisor] 警告: DSH 在 ${CRASH_WINDOW_MS / 1000}s 内已崩溃 ${crashes} 次，已暂停自动拉起`);
        return;
      }

      const delay = Math.min(1000 * Math.pow(1.5, crashes - 1), 10000);
      console.log(`[dsh-supervisor] DSH 意外退出，将在 ${(delay / 1000).toFixed(1)} 秒后自动拉起（窗口内第 ${crashes} 次）...`);
      clearTimeout(manager.restartTimer);
      manager.restartTimer = setTimeout(() => {
        if (!manager.stopping && !manager.installing && !manager.proc) {
          manager.boot().catch((err) => console.error('[dsh-supervisor] 自动拉起 DSH 失败:', err.message));
        }
      }, delay);
    }
  });

  waitReady(manager, 60000, onProbe).then(async (ok) => {
    try {
      manager.ready = ok;
      console.log(ok ? '[dsh-supervisor] DSH 已就绪' : '[dsh-supervisor] DSH 启动超时或崩溃');
      if (ok) {
        manager.autoHealCountInCurrentBoot = 0;
        manager.startTime = Date.now();
        if (manager.launchToken) {
          await exchangeSessionCookie(manager, manager.launchToken);
        }
        return resolve({ ok: true });
      }

      if (manager.autoHealEnabled && !manager.stopping && !manager.installing) {
        if (manager.autoHealCountInCurrentBoot < manager.maxAutoHealPerBoot) {
          const detected = detectCrashingPlugin(manager.recentLogs, manager.lastExitInfo);
          if (detected) {
            manager.autoHealCountInCurrentBoot++;
            console.warn(`[dsh-supervisor] 启动故障自愈 (${manager.autoHealCountInCurrentBoot}/${manager.maxAutoHealPerBoot}): 自动隔离拓展「${detected.name}」(${detected.matched})`);
            try {
              const pm = require('../plugins/plugin-manager');
              await pm.togglePlugin(detected.name, false);

              const event = {
                id: 'heal-' + Date.now(),
                plugin: detected.name,
                reason: detected.matched,
                time: Date.now(),
                logSnippet: manager.recentLogs.slice(-20).join('\n')
              };
              manager.autoIsolatedEvents.unshift(event);
              if (manager.autoIsolatedEvents.length > 10) manager.autoIsolatedEvents.pop();

              await ensurePortReleased(dshPort, 3000);
              const healBootRes = await bootProcess(manager, onProbe);
              return resolve(healBootRes);
            } catch (healErr) {
              console.error('[dsh-supervisor] 执行插件自动隔离失败:', healErr.message);
            }
          }
        } else {
          console.warn(`[dsh-supervisor] 当前启动周期内自动隔离拓展次数已达上限 (${manager.maxAutoHealPerBoot})`);
        }
      }

      resolve({ ok: false });
    } catch (e) {
      console.error('[dsh-supervisor] 就绪后处理异常:', (e && e.message) || e);
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
  }).catch((err) => {
    console.error('[dsh-supervisor] waitReady 异常:', (err && err.message) || err);
    resolve({ ok: false, error: (err && err.message) || String(err) });
  });
}

function stopProcess(manager) {
  const dshPort = getDshPort();
  return new Promise((resolve) => {
    manager.stopping = true;
    if (manager.restartTimer) {
      clearTimeout(manager.restartTimer);
      manager.restartTimer = null;
    }
    manager.crashWindow = [];

    const p = manager.proc;
    manager.proc = null;
    manager.ready = false;
    manager.upstreamCookie = '';

    killPortProcess(dshPort);

    if (!p) {
      manager.stopping = false;
      return resolve({ ok: true });
    }

    console.log('[dsh-supervisor] 停止 DSH 进程...');
    let settled = false;
    const done = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      manager.stopping = false;
      resolve({ ok: true, ...extra });
    };

    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      killPortProcess(dshPort);
    }, 4000);

    const hardTimer = setTimeout(() => {
      console.warn('[dsh-supervisor] 停止 DSH 超时（9s），强制返回');
      done({ forced: true });
    }, 9000);

    p.once('exit', async () => {
      try { await ensurePortReleased(dshPort, 2500); } catch {}
      done();
    });

    try {
      p.kill('SIGTERM');
    } catch {
      done();
    }
  });
}

module.exports = {
  getDshPort,
  redactLog,
  killPortProcess,
  isPortInUse,
  ensurePortReleased,
  exchangeSessionCookie,
  waitReady,
  bootProcess,
  stopProcess
};
