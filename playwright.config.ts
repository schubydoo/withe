import { defineConfig, devices } from '@playwright/test';

/**
 * Cross-browser smoke for NFR-17 (Task 3.12).
 *
 * A thin render check across the three engines — Chromium, Firefox, and
 * WebKit. WebKit is Playwright's Safari engine, a proxy for Safari and not
 * Safari itself; the README says so rather than claiming Safari support.
 *
 * The functional depth (the four flows, the accessibility audit) lives in the
 * agent-browser suite (`npm run e2e`). This exists only to prove the pages
 * render on all three engines, so it stays deliberately small.
 *
 * global-setup starts the stub CE, runs one real sync, and starts the web
 * server; global-teardown stops them. No live CE, no network.
 */
const PORT = 31_380;

export default defineConfig({
  testDir: './test/e2e/browsers',
  globalSetup: './test/e2e/browsers/global-setup.ts',
  globalTeardown: './test/e2e/browsers/global-teardown.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
