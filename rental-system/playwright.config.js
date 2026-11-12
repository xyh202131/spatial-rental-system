import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', timeout: 60_000, workers: 1, retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4328', channel: 'msedge', headless: true,
    viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node tests/e2e/start-server.mjs', url: 'http://127.0.0.1:4328/api/health', timeout: 20_000, reuseExistingServer: false,
  },
});
