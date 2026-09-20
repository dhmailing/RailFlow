import { NextResponse } from "next/server";

import { getSeatAvailabilityProviderFlag, isMockSeatSimulationEnabled, isSeatWatchJobsEnabled } from "@/lib/watch/feature-flags";
import { getSeatAvailabilityProvider } from "@/lib/watch/seat-provider";

export const dynamic = "force-dynamic";

// No auth required -- booleans and a capability object only, no job data,
// matching v0.4's /api/reservations/provider-status. Explicitly excluded
// from the Production simulate-route block so the UI can always show an
// honest "공식 좌석정보 Provider가 연결되지 않았습니다" state.
export async function GET() {
  const seatAvailabilityProvider = getSeatAvailabilityProviderFlag();
  const capabilities = getSeatAvailabilityProvider().capabilities();

  return NextResponse.json({
    seatAvailabilityProvider,
    seatProviderCapabilities: capabilities,
    jobsEnabled: isSeatWatchJobsEnabled(),
    mockSimulationEnabled: isMockSeatSimulationEnabled() && process.env.NODE_ENV !== "production",
  });
}
