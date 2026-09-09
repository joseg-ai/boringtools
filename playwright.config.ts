import { defineConfig } from '@playwright/test';
import { origins } from './tests/fixtures/integration/origins';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? './test-results/e2e',
  use: {
    baseURL: origins.workspace,
    browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: 'phone-390', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'phone-320', use: { viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `npm run build --workspace=@domos/site && npm run build --workspace=@domos/workspace && node -e "import('./tests/fixtures/integration/serve-production.mjs')"`,
    url: `${origins.workspace}/__e2e/ready`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { ASTRO_TELEMETRY_DISABLED: '1', PUBLIC_API_ORIGIN: origins.api },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
