import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { resumeWatching } from "@/lib/watch/worker";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(20);

// The "다시 감시" button on a SEAT_FOUND job: the user tried to book and it
// did not work out (seat gone, changed their mind), so watching resumes.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    return NextResponse.json({ job: resumeWatching(id, user.id) });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
