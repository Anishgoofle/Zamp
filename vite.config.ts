/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { apiRoutes } from './vite-plugin-api';

export default defineConfig(({ mode }) => {
  // The api handlers read `process.env` — they run on Vercel, not in the browser,
  // so they don't go through `import.meta.env` and its VITE_ prefix rule.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

  return {
    plugins: [react(), apiRoutes()],
    resolve: {
      alias: {
        '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
        '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
