import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { cancelWatchJob } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(12);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    return NextResponse.json({ job: cancelWatchJob(id, user.id) });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
