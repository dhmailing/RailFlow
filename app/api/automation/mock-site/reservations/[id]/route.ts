import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/automation/http";
import { isMockBookingSiteEnabled } from "@/lib/automation/feature-flags";
import { cancelReservation, getReservation } from "@/lib/automation/mock-booking-site/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isMockBookingSiteEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "Mock 예매 시뮬레이터가 이 환경에서 비활성화되어 있습니다.");
  }
  const { id } = await params;
  const reservation = getReservation(id);
  if (!reservation) return errorResponse(404, "NOT_FOUND", "예약을 찾을 수 없습니다.");
  const response = NextResponse.json({ reservation });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// 좌석 재반영(§3-A "예약 취소" + "좌석 재반영"): 취소된 예약의 좌석은
// checkSeatStatus()가 활성 예약 수를 빼는 방식으로 이미 자동 반영된다 --
// 별도의 "좌석 복원" 로직이 필요 없다.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isMockBookingSiteEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "Mock 예매 시뮬레이터가 이 환경에서 비활성화되어 있습니다.");
  }
  const { id } = await params;
  const reservation = cancelReservation(id);
  if (!reservation) return errorResponse(404, "NOT_FOUND", "예약을 찾을 수 없습니다.");
  const response = NextResponse.json({ reservation });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
