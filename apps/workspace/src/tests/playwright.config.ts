import { defineConfig } from '@playwright/test';
import release from '../../../../playwright.config';

export default defineConfig({
  ...release,
  testDir: '.',
  testMatch: 'browser.spec.ts',
});
