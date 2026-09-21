import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

import { isRealProductionEnvironment, isSeatAutomationJobsEnabled } from "@/lib/automation/feature-flags";
import { automationErrorResponse, createRateLimiter, errorResponse } from "@/lib/automation/http";
import { runJobOnce } from "@/lib/automation/worker";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ idempotencyKey: z.string().min(1).max(200) });

// The client polls this once per `intervalSeconds` while a job is WATCHING
// (§C: that interval only ever governs how often *this* route -- talking
// only to RailFlow's own Mock booking site -- is called; it is never a
// click/request interval against a real railway site). Each call runs
// exactly one Worker step (searchAvailability, and on a hit,
// clickPurchase+reserve in the same step) -- never a loop of its own.
const isRateLimited = createRateLimiter(60);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isRealProductionEnvironment() || !isSeatAutomationJobsEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "자동 좌석조회·예약 매크로가 아직 활성화되지 않았습니다.");
  }
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_BODY", "idempotencyKey가 필요합니다.");
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_BODY", "idempotencyKey가 필요합니다.");
    }

    const job = await runJobOnce(id, user.id, parsed.data.idempotencyKey);
    const response = NextResponse.json({ job });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}
