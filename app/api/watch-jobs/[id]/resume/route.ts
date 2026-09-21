import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { resumeWatching } from "@/lib/watch/worker";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(20);

// The "다시 감시" button on a SEAT_FOUND job: the user tried to book and it
// did not work out (seat gone, changed their mind), so watching resumes.
// Also advances the job's watchCycle (lib/watch/worker.ts) so a re-detected
// candidate can notify again (§6 검토사항).
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
    const response = NextResponse.json({ job: resumeWatching(id, user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}
