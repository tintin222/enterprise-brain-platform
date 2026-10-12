// The brain's pages (docs/brain/01-phase0-plan.md section 10). `pnpm --filter @brain/brain-web build` writes
// dist/, which the brain API serves (BRAIN_WEB_DIR). `pnpm --filter @brain/brain-web dev` proxies the API.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.BRAIN_API_URL ?? 'http://localhost:9120';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': api, '/auth': api, '/mm': api },
  },
});
