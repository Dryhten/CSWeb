import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function devServerPortFromEnv(env: Record<string, string>): number {
  const raw = env.CLIENT_PORT ?? env.VITE_CLIENT_PORT ?? '5173';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 5173;
}

export default defineConfig(({ mode }) => {
  const clientDir = path.resolve(__dirname);
  const repoRoot = path.resolve(__dirname, '..');
  const env = { ...loadEnv(mode, repoRoot, ''), ...loadEnv(mode, clientDir, '') };
  const port = devServerPortFromEnv(env);

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/socket.io': {
          target: 'http://localhost:3000',
          ws: true,
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          game: path.resolve(__dirname, 'game.html'),
        },
      },
    },
  };
});