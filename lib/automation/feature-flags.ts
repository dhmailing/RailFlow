import "server-only";

export type SeatAutomationProviderFlag = "unavailable" | "mock-browser" | "official";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

// Fail-closed: unrecognized or missing values always fall back to the
// safest option ("unavailable"), never to something more permissive.
export function getSeatAutomationProviderFlag(): SeatAutomationProviderFlag {
  const value = readEnv("SEAT_AUTOMATION_PROVIDER");
  return value === "mock-browser" || value === "official" ? value : "unavailable";
}

export function isSeatAutomationJobsEnabled(): boolean {
  return readEnv("ENABLE_SEAT_AUTOMATION_JOBS") === "true";
}

// (§3-E 호스트 안전장치) real Production is blocked unconditionally,
// regardless of any env var. This is deliberately keyed on VERCEL_ENV, not
// NODE_ENV: Vercel Preview deployments build in Next.js "production" mode
// (NODE_ENV==="production") but are still meant to be demoable per this
// PR's own spec ("승인된 Vercel Preview의 /demo/booking-simulator" is listed
// as an *allowed* automation target) -- see docs/V0.7-AUTOMATION-BOUNDARY.md.
// VERCEL_ENV is set by the Vercel platform itself ("production"|"preview"|
// "development"), never by this app's own config, so a Preview deployment
// cannot be mistaken for real Production just because someone sets an env
// var on it.
export function isRealProductionEnvironment(): boolean {
  return readEnv("VERCEL_ENV") === "production";
}

export function isAutomationProviderUsable(): boolean {
  return getSeatAutomationProviderFlag() === "mock-browser" && isSeatAutomationJobsEnabled() && !isRealProductionEnvironment();
}

// The Mock booking site itself (lib/automation/mock-booking-site/**,
// app/demo/booking-simulator) is gated independently of the automation
// Provider/job kill switches above -- a human should be able to browse it
// standalone in dev/Preview even before ENABLE_SEAT_AUTOMATION_JOBS is
// turned on, but it must still never be reachable in real Production.
export function isMockBookingSiteEnabled(): boolean {
  return readEnv("ENABLE_MOCK_BOOKING_SITE") === "true" && !isRealProductionEnvironment();
}
