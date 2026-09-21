import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/automation/http";
import { isMockBookingSiteEnabled } from "@/lib/automation/feature-flags";
import { ensureMockBookingSiteSeeded } from "@/lib/automation/mock-booking-site/seed";
import { checkSeatStatus } from "@/lib/automation/mock-booking-site/store";

export const dynamic = "force-dynamic";

// Every call here is one "check" (§3-A: determinism is a pure function of
// how many times this endpoint has been hit for this listing, never of wall
// clock time) -- both a human refreshing the page and the automation
// Worker's Playwright browser count identically, since both ultimately call
// this same endpoint.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isMockBookingSiteEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "Mock 예매 시뮬레이터가 이 환경에서 비활성화되어 있습니다.");
  }
  ensureMockBookingSiteSeeded();
  const { id } = await params;
  try {
    const status = checkSeatStatus(id);
    const response = NextResponse.json({ status });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return errorResponse(404, "NOT_FOUND", "해당 열차를 찾을 수 없습니다.");
  }
}
