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

  // 1. WebSocket Endpoint for bidirectional CDP screencast and user input
  app.get('/admin/remote-browser/ws', { websocket: true }, (socket, req) => {
    const query = req.query as { token?: string };
    const token = query?.token;

    if (!token) {
      socket.send(JSON.stringify({ type: 'error', message: 'Missing session token' }));
      socket.close();
      return;
    }

    void container.remoteBrowserService.handleWebSocketConnection(token, socket);
  });

  // 2. HTML5 Web App Viewer for Mobile & Desktop
  app.get('/admin/remote-browser', async (req, reply) => {
    const query = req.query as { token?: string };
    const token = query?.token;

    if (!token) {
      return reply.status(400).type('text/html').send(`
        <html>
          <body style="font-family:sans-serif; background:#121212; color:#fff; text-align:center; padding:50px;">
            <h2>❌ Ошибка: Отсутствует токен сессии</h2>
            <p>Запустите авторизацию заново из Telegram-бота через команду /auth_fb или /auth_k24.</p>
          </body>
        </html>
      `);
    }

    const sessionInfo = container.remoteBrowserService.verifySessionToken(token);
    if (!sessionInfo) {
      return reply.status(401).type('text/html').send(`
        <html>
          <body style="font-family:sans-serif; background:#121212; color:#fff; text-align:center; padding:50px;">
            <h2>⚠️ Токен устарел или недействителен</h2>
            <p>Срок действия ссылки (15 минут) истек. Запросите новую сессию в Telegram-боте.</p>
          </body>
        </html>
      `);
    }

    const serviceName = sessionInfo.service === 'facebook' ? 'Facebook (Residential Proxy)' : 'Khmer24 (Direct)';

    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>HomEasy Remote Browser — ${serviceName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background: #0f141c;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      background: #238636;
      color: #fff;
      font-weight: 500;
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
    .status-dot.connected { background: #2ea043; }

    .actions {
      display: flex;
      gap: 6px;
    }
    button.btn {
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    button.btn:active { background: #30363d; }
    button.btn-primary { background: #238636; color: #fff; border-color: #2ea043; }

    #viewport-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      position: relative;
      overflow: hidden;
    }
    #screencast {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      cursor: crosshair;
    }

    /* Mobile Text Toolbar */
    #toolbar {
      background: #161b22;
      border-top: 1px solid #30363d;
      padding: 8px 10px;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    #input-text {
      flex: 1;
      background: #0d1117;
      border: 1px solid #30363d;
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      user-select: text;
    }
    #input-text:focus { border-color: #58a6ff; }

    /* Success Overlay */
    #overlay-success {
      display: none;
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(15, 20, 28, 0.92);
      backdrop-filter: blur(6px);
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      text-align: center;
      z-index: 100;
    }
    #overlay-success.active { display: flex; }
    .success-icon { font-size: 48px; margin-bottom: 12px; }
    .success-text { font-size: 18px; font-weight: 600; color: #3fb950; margin-bottom: 8px; }
    .success-sub { font-size: 13px; color: #8b949e; max-width: 320px; }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="title">🌐 ${serviceName}</div>
      <div class="status">
        <div id="dot" class="status-dot"></div>
        <span id="status-label">Подключение...</span>
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="sendAction({ type: 'reload' })">🔄</button>
      <button class="btn btn-primary" onclick="sendAction({ type: 'save_manual' })">💾 Сохранить</button>
    </div>
  </header>

  <div id="viewport-container">
    <canvas id="screencast" width="1280" height="800"></canvas>

    <div id="overlay-success">
      <div class="success-icon">🎉</div>
      <div class="success-text" id="success-msg">Сессия успешно сохранена!</div>
      <div class="success-sub">Вы можете закрыть эту вкладку. Скрапер продолжит сбор данных через резидентный прокси.</div>
    </div>
  </div>

  <div id="toolbar">
    <input type="text" id="input-text" placeholder="Логин, пароль или 2FA..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
    <button class="btn btn-primary" onclick="submitTextInput()">Ввести</button>
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

    const PAGE_W = 1280;
    const PAGE_H = 800;

    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + loc.host + '/admin/remote-browser/ws?token=${token}';

    let ws = null;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        dot.className = 'status-dot connected';
        statusLabel.textContent = 'Браузер подключен';
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
            statusLabel.textContent = 'Авторизовано!';
          } else if (msg.type === 'error') {
            alert('Ошибка: ' + msg.message);
            statusLabel.textContent = 'Ошибка';
          }
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        dot.className = 'status-dot';
        statusLabel.textContent = 'Сессия завершена';
      };

      ws.onerror = () => {
        dot.className = 'status-dot';
        statusLabel.textContent = 'Ошибка соединения';
      };
    }

    function sendAction(payload) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
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

    // Touch & Mouse Coordinate Translation to 1280x800 Page
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

