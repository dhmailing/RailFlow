import { defineConfig, devices } from "@playwright/test";

// v0.7 E2E suite. Two kinds of tests live under tests/e2e/:
//   - booking-automation-demo.spec.ts drives the public, login-free
//     /demo/booking-automation page through @playwright/test's own `page`
//     fixture (a real browser).
//   - mock-browser-provider.contract.spec.ts imports
//     lib/automation/providers/mock-browser-provider.ts directly and calls
//     its real methods (which launch their own Playwright browser
//     internally) against a running server's /demo/booking-simulator.
// Both need a real Node.js server -- this repo's `pnpm dev` runs under
// Cloudflare Workers/workerd, which cannot load `playwright` at all (see
// docs/V0.7-AUTOMATION-BOUNDARY.md §5); `next dev` is a plain Node.js
// process where it works. See docs/V0.7-PREVIEW-DEMO-AUDIT.md §4 for how
// this was verified.
//
// The sandbox's pre-installed Chromium is pinned to a revision older than
// this `playwright`/`@playwright/test` version's default expected build;
// PLAYWRIGHT_CHROMIUM_PATH below and in webServer's env point both the test
// runner's own browser and mock-browser-provider.ts's internal
// chromium.launch() at that same binary.
const CHROMIUM_EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const PORT = Number(process.env.PLAYWRIGHT_WEB_SERVER_PORT || 3000);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    launchOptions: { executablePath: CHROMIUM_EXECUTABLE_PATH },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec next dev -p " + PORT,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      // §C: mock-browser is the real Playwright-driven Provider; every
      // target it can ever reach is RailFlow's own /demo/booking-simulator
      // (lib/automation/host-guard.ts's allowlist) on this same dev server.
      SEAT_AUTOMATION_PROVIDER: "mock-browser",
      ENABLE_SEAT_AUTOMATION_JOBS: "true",
      ENABLE_MOCK_BOOKING_SITE: "true",
      // dev/test-only in-memory account store (never usable in Production,
      // see lib/auth/feature-flags.ts) -- needed only by tests that exercise
      // the authenticated /api/automation-jobs/** path, not by the public
      // /demo/booking-automation page.
      AUTH_STORE: "memory",
      PLAYWRIGHT_CHROMIUM_PATH: CHROMIUM_EXECUTABLE_PATH,
      AUTOMATION_TARGET_BASE_URL: BASE_URL,
    },
  },
});
