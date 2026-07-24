import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  webServer: {
    command: 'node tests/e2e/test-server.js',
    url: 'http://localhost:58173',
    // Never reuse an already-running server on this port: it may belong to
    // an unrelated project on the developer's machine (this bit us once —
    // a SvelteKit dev server happened to be on the more obvious 5173).
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
