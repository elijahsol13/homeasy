import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';

interface RemoteBrowserRoutesOptions {
  container: AppContainer;
}

export const remoteBrowserRoutes: FastifyPluginAsync<RemoteBrowserRoutesOptions> = async (
  app: FastifyInstance,
  options: RemoteBrowserRoutesOptions,
) => {
  const { container } = options;

  const adminRateLimitConfig = {
    rateLimit: {
      max: 5,
      timeWindow: '1 minute',
      errorResponseBuilder: (_request: unknown, context: { ttl: number }) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Too many remote browser connection attempts (limit: 5/min). Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      }),
    },
  };

  // 1. WebSocket Endpoint for bidirectional CDP screencast and user input (5 req/min)
  app.get('/admin/remote-browser/ws', { websocket: true, config: adminRateLimitConfig }, (socket, req) => {
    const query = req.query as { token?: string };
    const token = query?.token;

    if (!token) {
      socket.send(JSON.stringify({ type: 'error', message: 'Missing session token' }));
      socket.close();
      return;
    }

    void container.remoteBrowserService.handleWebSocketConnection(token, socket);
  });

  // 2. HTML5 Web App Viewer for Mobile & Desktop (5 req/min)
  app.get('/admin/remote-browser', { config: adminRateLimitConfig }, async (req, reply) => {
    const query = req.query as { token?: string };
    const token = query?.token;

    if (!token) {
      return reply.status(400).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
        <html lang="en">
          <head><meta charset="utf-8"><title>Token Error</title></head>
          <body style="font-family:sans-serif; background:#121212; color:#fff; text-align:center; padding:50px;">
            <h2>❌ Error: Missing Session Token</h2>
            <p>Please launch authorization again from the Telegram bot using /auth_fb or /auth_k24.</p>
          </body>
        </html>
      `);
    }

    const sessionInfo = container.remoteBrowserService.verifySessionToken(token);
    if (!sessionInfo) {
      return reply.status(401).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
        <html lang="en">
          <head><meta charset="utf-8"><title>Token Expired</title></head>
          <body style="font-family:sans-serif; background:#121212; color:#fff; text-align:center; padding:50px;">
            <h2>⚠️ Token Expired or Invalid</h2>
            <p>The 15-minute link has expired. Please request a new session in the Telegram bot.</p>
          </body>
        </html>
      `);
    }

    const serviceName = sessionInfo.service === 'facebook' ? 'Facebook (Residential Proxy)' : 'Khmer24 (Direct)';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${serviceName} — Remote Session</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      background-color: #0d1117;
      color: #c9d1d9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      color: #58a6ff;
    }
    .status {
      font-size: 12px;
      color: #8b949e;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f85149;
    }
    .status-dot.connected {
      background: #2ea043;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      background: #21262d;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .btn-primary {
      background: #238636;
      border-color: #2ea043;
      color: #fff;
    }
    .btn:active {
      opacity: 0.8;
    }
    #viewport-container {
      flex: 1;
      display: flex;
      justify-content: center;
      align-items: center;
      background: #010409;
      position: relative;
      overflow: hidden;
    }
    canvas {
      width: 100%;
      max-width: 414px;
      height: auto;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 0 20px rgba(0,0,0,0.8);
      touch-action: none;
    }
    #toolbar {
      background: #161b22;
      border-top: 1px solid #30363d;
      padding: 8px 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    #input-text {
      flex: 1;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 8px 12px;
      color: #c9d1d9;
      font-size: 14px;
      outline: none;
    }
    #input-text:focus {
      border-color: #58a6ff;
    }
    .quick-bar {
      background: #161b22;
      border-bottom: 1px solid #21262d;
      padding: 6px 12px;
      display: flex;
      gap: 6px;
      overflow-x: auto;
      flex-shrink: 0;
    }
    .quick-bar .btn {
      font-size: 11px;
      padding: 4px 8px;
      white-space: nowrap;
    }
    #overlay-success {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(13, 17, 23, 0.92);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10;
      display: none;
    }
    #overlay-success.active {
      display: flex;
    }
    .success-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    .success-text {
      font-size: 18px;
      font-weight: 600;
      color: #3fb950;
      margin-bottom: 8px;
    }
    .success-sub {
      font-size: 13px;
      color: #8b949e;
      text-align: center;
      max-width: 280px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="title">🌐 ${serviceName}</div>
      <div class="status">
        <div id="dot" class="status-dot"></div>
        <span id="status-label">Connecting...</span>
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="reloadPage()">🔄</button>
      <button class="btn btn-primary" onclick="sendAction({ type: 'save_manual' })">💾 Save Session</button>
    </div>
  </header>

  <div class="quick-bar">
    <span style="font-size: 11px; color: #8b949e; margin-right: 2px;">Quick:</span>
    <button class="btn" onclick="focusField('email')">👤 Username</button>
    <button class="btn" onclick="focusField('password')">🔑 Password</button>
    <button class="btn btn-primary" onclick="focusField('submit')">🚀 Sign In</button>
    <button class="btn" onclick="focusField('2fa')">📲 2FA Code</button>
    <button class="btn" onclick="requestScreenshot()">📸 Refresh</button>
  </div>

  <div id="viewport-container">
    <canvas id="screencast" width="414" height="750"></canvas>

    <div id="overlay-success">
      <div class="success-icon">🎉</div>
      <div class="success-text" id="success-msg">Session saved successfully!</div>
      <div class="success-sub">You can close this tab. The scraper will continue collecting listings automatically.</div>
    </div>
  </div>

  <div id="toolbar">
    <input type="text" id="input-text" placeholder="Username, password, or 2FA code..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
    <button class="btn btn-primary" onclick="submitTextInput()">Send</button>
    <button class="btn" onclick="sendAction({ type: 'press', key: 'Backspace' })">⌫</button>
    <button class="btn" onclick="sendAction({ type: 'press', key: 'Tab' })">⇥</button>
    <button class="btn" onclick="sendAction({ type: 'press', key: 'Enter' })">⏎</button>
  </div>

  <script>
    const canvas = document.getElementById('screencast');
    const ctx = canvas.getContext('2d');
    const dot = document.getElementById('dot');
    const statusLabel = document.getElementById('status-label');
    const inputText = document.getElementById('input-text');
    const overlaySuccess = document.getElementById('overlay-success');
    const successMsg = document.getElementById('success-msg');

    const PAGE_W = 414;
    const PAGE_H = 750;

    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + loc.host + '/admin/remote-browser/ws?token=${token}';

    let ws = null;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        dot.className = 'status-dot connected';
        statusLabel.textContent = 'Browser connected';
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'frame' && msg.data) {
            const img = new Image();
            img.onload = () => {
              ctx.drawImage(img, 0, 0, PAGE_W, PAGE_H);
            };
            img.src = 'data:image/jpeg;base64,' + msg.data;
          } else if (msg.type === 'status') {
            statusLabel.textContent = msg.text;
          } else if (msg.type === 'success') {
            successMsg.textContent = msg.message;
            overlaySuccess.className = 'active';
            statusLabel.textContent = 'Authorized!';
          } else if (msg.type === 'error') {
            alert('Error: ' + msg.message);
            statusLabel.textContent = 'Error';
          }
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        dot.className = 'status-dot';
        statusLabel.textContent = 'Session ended';
      };

      ws.onerror = () => {
        dot.className = 'status-dot';
        statusLabel.textContent = 'Connection error';
      };
    }

    function sendAction(payload) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    }

    function reloadPage() {
      statusLabel.textContent = 'Reloading...';
      sendAction({ type: 'reload' });
    }

    function requestScreenshot() {
      statusLabel.textContent = 'Refreshing frame...';
      sendAction({ type: 'capture_screen' });
    }

    function focusField(field) {
      statusLabel.textContent = 'Focus: ' + (field === 'email' ? 'username' : field === 'password' ? 'password' : field === '2fa' ? '2FA code' : 'submit');
      sendAction({ type: 'focus_field', field });
      if (field !== 'submit') {
        inputText.focus();
      }
    }

    function submitTextInput() {
      const text = inputText.value;
      if (text) {
        sendAction({ type: 'type', text });
        inputText.value = '';
      }
    }

    inputText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        submitTextInput();
      }
    });

    // Touch & Mouse Coordinate Translation to 414x750 Page
    function getNormalizedCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      const x = Math.round(((clientX - rect.left) / rect.width) * PAGE_W);
      const y = Math.round(((clientY - rect.top) / rect.height) * PAGE_H);
      return { x: Math.max(0, Math.min(PAGE_W, x)), y: Math.max(0, Math.min(PAGE_H, y)) };
    }

    canvas.addEventListener('click', (e) => {
      const coords = getNormalizedCoords(e);
      sendAction({ type: 'click', x: coords.x, y: coords.y });
    });

    let touchStartY = 0;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        const delta = touchStartY - e.touches[0].clientY;
        if (Math.abs(delta) > 15) {
          sendAction({ type: 'scroll', deltaY: delta * 2 });
          touchStartY = e.touches[0].clientY;
        }
      }
    }, { passive: true });

    connect();
  </script>
</body>
</html>`;

    return reply.type('text/html').send(html);
  });
};

