import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // A separate Pages build for guests. The existing default build remains TMA.
  plugins: [react(), tailwindcss(), {
    name: 'homeasy-telegram-sdk',
    transformIndexHtml(html: string) {
      return mode === 'web' ? html.replace(/\s*<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js\?64"><\/script>/, '') : html;
    },
  }],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api/v1': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
}));
