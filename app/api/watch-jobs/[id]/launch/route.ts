import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { koreailWebFallbackBookingLaunchProvider } from "@/lib/watch/booking-launch-provider";
import { errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { getWatchJob } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

// Returns where "코레일+에서 예매하기" should send the user for this job's
// found candidate. Never mutates the job -- booking completion is only ever
// recorded by the user's own "예매 완료" tap (confirm-booking route).
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    const candidateId = request.nextUrl.searchParams.get("candidateId") ?? "";
    if (!candidateId) {
      return errorResponse(400, "INVALID_INPUT", "candidateId를 확인해주세요.");
    }
    const job = getWatchJob(id, user.id);
    const result = await koreailWebFallbackBookingLaunchProvider.launch(job, candidateId);
    return NextResponse.json(result);
  } catch (error) {
    return watchErrorResponse(error);
  }
}
