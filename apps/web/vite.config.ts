// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', emptyOutDir: true, sourcemap: false },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
  clearScreen: false,
});
