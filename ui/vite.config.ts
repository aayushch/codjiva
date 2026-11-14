import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// The theme tokens live in the repository's shared resources folder, one level above this
// package, so the dev server is allowed to read from there.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  // Tauri shows its own errors, so Vite must not clear the terminal over them.
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)), $resources: fileURLToPath(new URL('../resources', import.meta.url)) },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
