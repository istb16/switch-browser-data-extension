import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/support/vitest.setup.js'],
    include: ['tests/unit/**/*.test.js'],
    // setupFiles run after the environment is installed, which is too late to
    // undo Node 26's localStorage/sessionStorage globals — see the preload.
    execArgv: ['--import', './tests/support/strip-node-storage.js'],
  },
});
