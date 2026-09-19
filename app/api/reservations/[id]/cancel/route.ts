import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  DEMO_USER_ID_PATTERN,
  createRateLimiter,
  errorResponse,
  isProductionEnvironment,
  productionBlockedResponse,
  reservationErrorResponse,
} from "@/lib/reservation/http";
import { cancelJob } from "@/lib/reservation/job-store";

export const dynamic = "force-dynamic";

const cancelSchema = z.object({ userId: z.string().regex(DEMO_USER_ID_PATTERN) });
const isRateLimited = createRateLimiter(12);

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

  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_USER", "데모 사용자 ID를 확인해주세요.");
  }

  try {
    const job = cancelJob(id, parsed.data.userId);
    return NextResponse.json({ job });
  } catch (error) {
    return reservationErrorResponse(error);
  }
}
