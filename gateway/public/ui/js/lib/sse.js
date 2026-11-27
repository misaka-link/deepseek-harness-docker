/**
 * Idle-timeout SSE streaming reader (Issue #9: prevents false aborts on long core-switch / rollback tasks).
 * Resets a 60s idle watchdog whenever any chunk arrives from the server.
 */

export const SSE_IDLE_TIMEOUT_MS = 60000;

export async function openSseStream(url, init = {}, { idleTimeoutMs = SSE_IDLE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let idleTimer = null;

  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, idleTimeoutMs);
  };

  arm();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    return {
      response,
      onData: arm,
      close: () => clearTimeout(idleTimer)
    };
  } catch (err) {
    clearTimeout(idleTimer);
    throw err;
  }
}

/**
 * Consume an opened SSE stream and dispatch parsed `data:` JSON frames.
 * @param {{ response: Response, onData: () => void, close: () => void }} sse
 * @param {{ onProgress?: (p: any) => void, onLog?: (p: any) => void, onDone?: (p: any) => void, onEvent?: (p: any) => void }} handlers
 */
export async function consumeSseStream(sse, handlers = {}) {
  const { response, onData } = sse;
  const ct = response.headers.get('content-type') || '';
  if (!response.ok && !ct.includes('text/event-stream')) {
    const errBody = await response.json().catch(() => ({}));
    const err = new Error(errBody.error || `HTTP ${response.status}`);
    err.errorCode = errBody.errorCode;
    err.params = errBody.params;
    err.status = response.status;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onData();
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const rawJson = trimmed.slice(5).trim();
        if (!rawJson) continue;
        let payload;
        try {
          payload = JSON.parse(rawJson);
        } catch {
          continue;
        }
        if (handlers.onEvent) handlers.onEvent(payload);
        if (payload.type === 'progress' && handlers.onProgress) {
          handlers.onProgress(payload);
        } else if (payload.type === 'log' && handlers.onLog) {
          handlers.onLog(payload);
        } else if (payload.type === 'done') {
          sawDone = true;
          if (handlers.onDone) await handlers.onDone(payload);
        }
      }
    }
  }

  return { sawDone };
}
