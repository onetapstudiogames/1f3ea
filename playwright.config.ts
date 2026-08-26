import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'line',
  outputDir: 'test-results',
  expect: { timeout: 5_000 },
  use: {
    browserName: 'chromium',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'phone-light', use: { viewport: { width: 320, height: 640 }, colorScheme: 'light' } },
    { name: 'phone-dark', use: { viewport: { width: 320, height: 640 }, colorScheme: 'dark' } },
    { name: 'tablet-light', use: { viewport: { width: 768, height: 1024 }, colorScheme: 'light' } },
    { name: 'tablet-dark', use: { viewport: { width: 768, height: 1024 }, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
  ],
})
