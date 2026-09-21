import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { cancelWatchJob } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(12);

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
    const response = NextResponse.json({ job: cancelWatchJob(id, user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}
