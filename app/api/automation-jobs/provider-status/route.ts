import { NextResponse } from "next/server";

import { isMockBookingSiteEnabled, isRealProductionEnvironment, isSeatAutomationJobsEnabled } from "@/lib/automation/feature-flags";
import { checkMockBrowserRuntimeSupport, getSeatAutomationProvider, getSeatAutomationProviderName } from "@/lib/automation/provider";

export const dynamic = "force-dynamic";

// No auth required -- booleans and a capability object only, matching
// v0.4/v0.5's own provider-status routes. Never leaks a secret: no env var
// values, no host names, no stack traces -- only the already-public shape
// of "which Provider is active and can this runtime actually run it".
export async function GET() {
  const seatAutomationProvider = getSeatAutomationProviderName();
  const capabilities = (await getSeatAutomationProvider()).capabilities();
  const runtimeSupported = seatAutomationProvider === "mock-browser" ? await checkMockBrowserRuntimeSupport() : true;
  const environment = process.env.VERCEL_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development");

  const response = NextResponse.json({
    // New, explicitly requested shape.
    provider: seatAutomationProvider,
    configured: seatAutomationProvider !== "unavailable",
    runtimeSupported,
    environment,
    // Always false: this app has no path -- today or planned -- that
    // targets a real external site (see docs/V0.7-AUTOMATION-BOUNDARY.md).
    externalAutomationAllowed: false,
    // Kept for components/automation/automation-jobs.tsx, which already
    // reads these field names.
    seatAutomationProvider,
    seatAutomationCapabilities: capabilities,
    jobsEnabled: isSeatAutomationJobsEnabled(),
    mockBookingSiteEnabled: isMockBookingSiteEnabled(),
    realProductionEnvironment: isRealProductionEnvironment(),
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
