import { NextResponse } from "next/server";

import {
  getReservationProviderFlag,
  getScheduleProviderFlag,
  isLiveReservationAllowed,
  isMockSimulationEnabled,
  isReservationJobsEnabled,
} from "@/lib/reservation/feature-flags";
import { getReservationProvider } from "@/lib/reservation/provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const reservationProvider = getReservationProviderFlag();
  const capabilities = reservationProvider === "disabled" ? null : getReservationProvider().capabilities();

  return NextResponse.json({
    scheduleProvider: getScheduleProviderFlag(),
    reservationProvider,
    reservationCapabilities: capabilities,
    jobsEnabled: isReservationJobsEnabled(),
    mockSimulationEnabled: isMockSimulationEnabled() && process.env.NODE_ENV !== "production",
    allowLiveReservation: isLiveReservationAllowed(),
  });
}
