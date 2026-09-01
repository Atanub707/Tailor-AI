import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    server: {
      // HMR is disabled via DISABLE_HMR env var (true in Docker/AI Studio).
      hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      // Disable file watching when DISABLE_HMR is true to save CPU.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/data/**', '**/config.ini'],
      },
    },
  };
});
