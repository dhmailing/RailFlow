import { NextResponse } from "next/server";

import { isMockBookingSiteEnabled, isRealProductionEnvironment, isSeatAutomationJobsEnabled } from "@/lib/automation/feature-flags";
import { getSeatAutomationProvider, getSeatAutomationProviderName } from "@/lib/automation/provider";

export const dynamic = "force-dynamic";

// No auth required -- booleans and a capability object only, matching
// v0.4/v0.5's own provider-status routes.
export async function GET() {
  const seatAutomationProvider = getSeatAutomationProviderName();
  const capabilities = (await getSeatAutomationProvider()).capabilities();

  const response = NextResponse.json({
    seatAutomationProvider,
    seatAutomationCapabilities: capabilities,
    jobsEnabled: isSeatAutomationJobsEnabled(),
    mockBookingSiteEnabled: isMockBookingSiteEnabled(),
    realProductionEnvironment: isRealProductionEnvironment(),
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
