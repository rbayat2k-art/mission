import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3210";

export default defineConfig({
  testDir:"./tests/e2e",
  timeout:30_000,
  expect:{ timeout:8_000 },
  fullyParallel:false,
  forbidOnly:Boolean(process.env.CI),
  retries:process.env.CI ? 1 : 0,
  reporter:[["list"]],
  use:{
    baseURL,
    channel:"chrome",
    locale:"fa-IR",
    timezoneId:"Asia/Tehran",
    trace:"retain-on-failure",
    screenshot:"only-on-failure",
  },
  webServer:process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    // CI has just built the release. Test that artifact, not React's development
    // StrictMode effect replay (which intentionally repeats read-only requests).
    command:process.env.CI ? "node .next/standalone/server.js" : "npm run dev -- -p 3210",
    env:{ PORT:"3210", HOSTNAME:"127.0.0.1", AUTO_MIGRATE:"false" },
    url:baseURL,
    reuseExistingServer:!process.env.CI,
    timeout:120_000,
  },
  projects:[
    { name:"desktop-chrome", use:{ ...devices["Desktop Chrome"] } },
    { name:"android-chrome", use:{ ...devices["Pixel 5"], channel:"chrome" } },
  ],
});
