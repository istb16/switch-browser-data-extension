import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/support/vitest.setup.js'],
    include: ['tests/unit/**/*.test.js'],
  },
});
