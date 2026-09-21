import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

import { automationErrorResponse, createRateLimiter, errorResponse } from "@/lib/automation/http";
import { cancelJob } from "@/lib/automation/job-store";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(12);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return automationErrorResponse(error);
  }
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    const response = NextResponse.json({ job: cancelJob(id, user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}
