import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import {
  createRateLimiter,
  errorResponse,
  isProductionEnvironment,
  productionSimulationBlockedResponse,
  watchErrorResponse,
} from "@/lib/watch/http";
import { assertSimulationAllowed } from "@/lib/watch/simulation-guard";
import { getWatchJob } from "@/lib/watch/store";
import { runJobOnce } from "@/lib/watch/worker";

export const dynamic = "force-dynamic";

const simulateSchema = z.object({
  idempotencyKey: z.string().min(1).max(120),
  // A JSON number 1-5 only -- see lib/watch/simulation-guard.ts. No
  // z.union/z.coerce with string, per the exact bug found in v0.4 PR #7's
  // final review round.
  tick: z.number().int().min(1).max(5),
});

const isRateLimited = createRateLimiter(30);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isProductionEnvironment()) {
    return productionSimulationBlockedResponse();
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
      return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
    }
    const parsed = simulateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_SIMULATE_INPUT", "tick(1~5)을 포함한 요청 값을 확인해주세요.");
    }

    // Always called, unconditionally, before runJobOnce -- no branch skips
    // it. If the job's Provider isn't "mock", the guard rejects regardless
    // of the tick value.
    const job = getWatchJob(id, user.id);
    assertSimulationAllowed({ tick: parsed.data.tick, seatProvider: job.seatProvider });

    const updated = await runJobOnce(id, user.id, parsed.data.idempotencyKey);
    return NextResponse.json({ job: updated });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
