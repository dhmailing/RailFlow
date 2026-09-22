import "server-only";

export type SeatAutomationProviderFlag = "unavailable" | "mock-browser" | "mock-direct" | "official";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

// Fail-closed: unrecognized or missing values always fall back to the
// safest option ("unavailable"), never to something more permissive.
export function getSeatAutomationProviderFlag(): SeatAutomationProviderFlag {
  const value = readEnv("SEAT_AUTOMATION_PROVIDER");
  return value === "mock-browser" || value === "mock-direct" || value === "official" ? value : "unavailable";
}

export function isSeatAutomationJobsEnabled(): boolean {
  return readEnv("ENABLE_SEAT_AUTOMATION_JOBS") === "true";
}

// (§3-E 호스트 안전장치) real Production is blocked unconditionally,
// regardless of any env var. VERCEL_ENV is preferred over NODE_ENV when
// present: Vercel Preview deployments build in Next.js "production" mode
// (NODE_ENV==="production") but are still meant to be demoable per this
// PR's own spec ("승인된 Vercel Preview의 /demo/booking-simulator" is listed
// as an *allowed* automation target) -- see docs/V0.7-AUTOMATION-BOUNDARY.md.
// VERCEL_ENV is set by the Vercel platform itself ("production"|"preview"|
// "development"), never by this app's own config, so a Preview deployment
// cannot be mistaken for real Production just because someone sets an env
// var on it.
//
// FIX (1단계 검증): the original version of this function returned
// `readEnv("VERCEL_ENV") === "production"` unconditionally -- when
// VERCEL_ENV is simply *absent* (any non-Vercel deployment: self-hosted,
// Docker, another PaaS, or `next build && next start` run directly), that
// expression evaluates to `"" === "production"` = false, meaning automation
// would be treated as usable on a real production deployment that just
// doesn't happen to run on Vercel. That is a fail-OPEN bug, not a
// fail-closed one. VERCEL_ENV is only a reliable "this is Preview, not
// Production" signal when the platform actually sets it; its mere absence
// must never be read as "therefore not Production" -- so when it is unset,
// this now falls back to NODE_ENV (the one signal every Node.js production
// build/run does set), fail-closed.
export function isRealProductionEnvironment(): boolean {
  const vercelEnv = readEnv("VERCEL_ENV");
  if (vercelEnv) {
    return vercelEnv === "production";
  }
  return process.env.NODE_ENV === "production";
}

export function isAutomationProviderUsable(): boolean {
  const flag = getSeatAutomationProviderFlag();
  return (flag === "mock-browser" || flag === "mock-direct") && isSeatAutomationJobsEnabled() && !isRealProductionEnvironment();
}

// The Mock booking site itself (lib/automation/mock-booking-site/**,
// app/demo/booking-simulator) is gated independently of the automation
// Provider/job kill switches above -- a human should be able to browse it
// standalone in dev/Preview even before ENABLE_SEAT_AUTOMATION_JOBS is
// turned on, but it must still never be reachable in real Production.
export function isMockBookingSiteEnabled(): boolean {
  return readEnv("ENABLE_MOCK_BOOKING_SITE") === "true" && !isRealProductionEnvironment();
}
