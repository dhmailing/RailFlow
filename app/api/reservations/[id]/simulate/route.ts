import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  createRateLimiter,
  DEMO_USER_ID_PATTERN,
  errorResponse,
  isProductionEnvironment,
  productionBlockedResponse,
  reservationErrorResponse,
} from "@/lib/reservation/http";
import { getJob } from "@/lib/reservation/job-store";
import { assertSimulationAllowed } from "@/lib/reservation/simulation-guard";
import { runJobOnce } from "@/lib/reservation/worker";

export const dynamic = "force-dynamic";

const simulateSchema = z.object({
  userId: z.string().regex(DEMO_USER_ID_PATTERN),
  idempotencyKey: z.string().min(1).max(120),
  // The "Mock 작업 시뮬레이션 간격" verification value: 1-5 as a JSON number,
  // and nothing else. Required (never optional) on purpose: an earlier
  // version of this route only validated it when present, which let a
  // request that simply omitted the field skip assertSimulationAllowed() and
  // reach the Worker even in production. z.number() alone (no z.union with
  // z.string(), no z.coerce) also matters: a later version of this route
  // accepted numeric *strings* ("1", "01", " 1 ") because
  // assertSimulationAllowed used to call Number(intervalSeconds) on whatever
  // it was given. Zod itself now rejects a string, null, boolean, array, or
  // object body before assertSimulationAllowed ever runs, and the guard below
  // no longer performs any type coercion either.
  simulationIntervalSeconds: z.number().int().min(1).max(5),
});

const isRateLimited = createRateLimiter(30);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isProductionEnvironment()) {
    return productionBlockedResponse();
  }
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }

  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
  }

  const parsed = simulateSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_SIMULATE_INPUT", "simulationIntervalSeconds(1~5)를 포함한 요청 값을 확인해주세요.");
  }
  const { userId, idempotencyKey, simulationIntervalSeconds } = parsed.data;

  try {
    // No branch skips this call. If the interval is missing, wrong-typed, out
    // of range, or the job's Provider isn't "mock", assertSimulationAllowed
    // throws before runJobOnce is ever reached, so the job's status/history/
    // attempts are left completely untouched.
    const job = getJob(id, userId);
    assertSimulationAllowed({ intervalSeconds: simulationIntervalSeconds, provider: job.provider });

    const updated = await runJobOnce(id, userId, idempotencyKey);
    return NextResponse.json({ job: updated });
  } catch (error) {
    return reservationErrorResponse(error);
  }
}
