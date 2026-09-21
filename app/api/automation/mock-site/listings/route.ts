import { NextResponse } from "next/server";

import { automationErrorResponse, errorResponse } from "@/lib/automation/http";
import { isMockBookingSiteEnabled } from "@/lib/automation/feature-flags";
import { ensureMockBookingSiteSeeded } from "@/lib/automation/mock-booking-site/seed";
import { listAllListings } from "@/lib/automation/mock-booking-site/store";

export const dynamic = "force-dynamic";

// RailFlow's own fake booking site listing feed -- never TAGO, never KORAIL.
// See lib/automation/mock-booking-site/store.ts's header for the full
// boundary rule. No auth required: this is a public demo page, exactly like
// /demo itself.
export async function GET() {
  try {
    if (!isMockBookingSiteEnabled()) {
      return errorResponse(503, "JOBS_DISABLED", "Mock 예매 시뮬레이터가 이 환경에서 비활성화되어 있습니다.");
    }
    ensureMockBookingSiteSeeded();
    const listings = listAllListings().map(({ id, trainNumber, trainType, departAt, arriveAt, fareLabel }) => ({
      id,
      trainNumber,
      trainType,
      departAt,
      arriveAt,
      fareLabel,
    }));
    const response = NextResponse.json({ listings });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}
