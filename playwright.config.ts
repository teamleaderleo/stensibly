import { defineConfig, devices } from "@playwright/test";

const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./browser-tests",
  outputDir: "artifacts/playwright-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ["line"],
    ["json", { outputFile: "artifacts/playwright-report/report.json" }],
  ],
  use: {
    baseURL,
    acceptDownloads: false,
    colorScheme: "light",
    locale: "en-US",
    permissions: [],
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        viewport: { width: 1_440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "bun scripts/serve-frontend-fixtures.ts",
    url: `${baseURL}/labs/`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  },
});
