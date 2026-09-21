import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/automation/http";
import { isMockBookingSiteEnabled } from "@/lib/automation/feature-flags";
import { ensureMockBookingSiteSeeded } from "@/lib/automation/mock-booking-site/seed";
import { recordPurchaseClick } from "@/lib/automation/mock-booking-site/store";

export const dynamic = "force-dynamic";

// Records that the "구매" button was pressed for this listing -- deliberately
// a separate, earlier fact than a completed reservation (§3-B: "구매 버튼을
// 눌렀다는 사실과 예약 성공은 별도 상태로 관리한다"). This alone never
// creates or holds a seat.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isMockBookingSiteEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "Mock 예매 시뮬레이터가 이 환경에서 비활성화되어 있습니다.");
  }
  ensureMockBookingSiteSeeded();
  const { id } = await params;
  try {
    const result = recordPurchaseClick(id);
    const response = NextResponse.json(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return errorResponse(404, "NOT_FOUND", "해당 열차를 찾을 수 없습니다.");
  }
}
