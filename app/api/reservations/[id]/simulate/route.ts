import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createRateLimiter, DEMO_USER_ID_PATTERN, errorResponse, reservationErrorResponse } from "@/lib/reservation/http";
import { getJob } from "@/lib/reservation/job-store";
import { assertSimulationAllowed } from "@/lib/reservation/simulation-guard";
import { runJobOnce } from "@/lib/reservation/worker";

export const dynamic = "force-dynamic";

const simulateSchema = z.object({
  userId: z.string().regex(DEMO_USER_ID_PATTERN),
  idempotencyKey: z.string().min(1).max(120),
  // Dev-tools-only "Mock 작업 시뮬레이션 간격": always re-validated on the
  // server via assertSimulationAllowed, never trusted from the client.
  simulationIntervalSeconds: z.union([z.number(), z.string()]).optional(),
});

const isRateLimited = createRateLimiter(30);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    return errorResponse(400, "INVALID_SIMULATE_INPUT", "요청 값을 확인해주세요.");
  }
  const { userId, idempotencyKey, simulationIntervalSeconds } = parsed.data;

  try {
    if (simulationIntervalSeconds !== undefined) {
      const job = getJob(id, userId);
      assertSimulationAllowed({ intervalSeconds: simulationIntervalSeconds, provider: job.provider });
    }

    const job = await runJobOnce(id, userId, idempotencyKey);
    return NextResponse.json({ job });
  } catch (error) {
    return reservationErrorResponse(error);
  }
}
