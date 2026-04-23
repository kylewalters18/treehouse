import { defineConfig, devices } from "@playwright/test";

/// Playwright config for treehouse E2E tests.
///
/// - Spawns Vite with `VITE_E2E=true` so the app installs a mock Tauri
///   IPC layer (see `src/test/e2e-bootstrap.ts`).
/// - Runs in WebKit to match Tauri's macOS webview; Chromium is available
///   as a faster secondary runner for iteration.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1421",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "VITE_E2E=true npm run dev -- --port 1421 --host 127.0.0.1",
    url: "http://localhost:1421",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
