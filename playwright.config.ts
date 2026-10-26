import { defineConfig } from '@playwright/test';
import chromium from '@sparticuz/chromium';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = process.env.TEST_DATABASE_URL;
if (
  !databaseUrl ||
  new URL(databaseUrl).pathname !== '/hub_cli_test' ||
  !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
)
  throw new Error('Browser tests require the dedicated loopback hub_cli_test database');
const packaged = process.env.HUB_PACKAGED_CHROMIUM === 'true';
export default defineConfig({
  globalSetup: './tests/e2e/global-setup.ts',
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    ...(packaged
      ? { launchOptions: { executablePath: await chromium.executablePath(), args: chromium.args } }
      : {}),
  },
  webServer: [
    {
      command:
        'node --env-file=.env --conditions=development --import tsx apps/control-api/src/main.ts',
      url: 'http://127.0.0.1:3101/readyz',
      reuseExistingServer: false,
      env: { PORT: '3101', DATABASE_URL: databaseUrl },
    },
    {
      command: 'node scripts/dashboard.mjs start --hostname 127.0.0.1 --port 3100',
      url: 'http://127.0.0.1:3100',
      reuseExistingServer: false,
      env: { CONTROL_API_URL: 'http://127.0.0.1:3101', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
