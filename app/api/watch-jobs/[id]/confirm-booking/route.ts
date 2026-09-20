import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { confirmBooking } from "@/lib/watch/worker";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(20);

// The "예매 완료" button. RailFlow never infers this automatically -- it is
// the one and only way a WatchJob reaches COMPLETED (§F: "예약이 완료됐는지는
// 자동 추정하지 말고 사용자가 예매 완료 버튼으로 확인하게 해라").
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    return NextResponse.json({ job: confirmBooking(id, user.id) });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
