import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        'e2e/',
        '*.config.js',
        'build.mjs',
        'service-worker.js',
        'app.js' // Exclude main app file from coverage (too complex)
      ]
    },
    setupFiles: ['./test/setup.js'],
    // Exclude app.js from tests (it has https:// imports that break in Node)
    exclude: [
      'node_modules/**',
      'dist/**',
      'e2e/**',
      '**/*.config.js',
      'app.js' // Exclude main app file
    ]
  }
});
