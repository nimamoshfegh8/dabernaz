const { defineConfig } = require('@playwright/test');

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://dabernaz.pages.dev';

if (!baseURL.startsWith('http://') && !baseURL.startsWith('https://')) {
  throw new Error('PLAYWRIGHT_BASE_URL must be an http(s) URL.');
}

const accessHeaders = {};
const accessClientId = process.env.CF_ACCESS_CLIENT_ID || '';
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET || '';
if (accessClientId && accessClientSecret) {
  accessHeaders['CF-Access-Client-Id'] = accessClientId;
  accessHeaders['CF-Access-Client-Secret'] = accessClientSecret;
}

const traceMode = process.env.PLAYWRIGHT_TRACE === 'off'
  ? 'off'
  : 'retain-on-failure';

module.exports = defineConfig({
  testDir: './tests/playwright',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  outputDir: 'test-results',
  use: {
    baseURL,
    browserName: 'chromium',
    extraHTTPHeaders: accessHeaders,
    screenshot: 'only-on-failure',
    trace: traceMode,
    actionTimeout: 10_000,
    navigationTimeout: 20_000
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
