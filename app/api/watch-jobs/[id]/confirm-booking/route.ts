import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { confirmBooking } from "@/lib/watch/worker";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(20);

// The "예매 완료" button. RailFlow never infers this automatically -- it is
// the one and only way a WatchJob reaches COMPLETED (§F: "예약이 완료됐는지는
// 자동 추정하지 말고 사용자가 예매 완료 버튼으로 확인하게 해라").
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isWatchStoreUsable()) {
    return errorResponse(503, "WATCH_STORE_DISABLED", "취소표 감시 저장소가 아직 준비되지 않았습니다.");
  }
  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return watchErrorResponse(error);
  }
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    const response = NextResponse.json({ job: confirmBooking(id, user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}
