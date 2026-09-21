import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

import { isRealProductionEnvironment, isSeatAutomationJobsEnabled } from "@/lib/automation/feature-flags";
import { automationErrorResponse, createRateLimiter, errorResponse } from "@/lib/automation/http";
import { createJob, listJobs } from "@/lib/automation/job-store";
import { getSeatAutomationProviderName } from "@/lib/automation/provider";
import type { AutomationJobInput } from "@/lib/automation/types";

export const dynamic = "force-dynamic";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

// candidate.id must reference an existing lib/automation/mock-booking-site
// listing (§3-A's three seeded listings in dev/test) -- the scenario itself
// lives server-side on that listing, never on the client-supplied candidate
// (see lib/automation/types.ts's AutomationCandidate doc comment).
const candidateSchema = z.object({
  id: z.string().min(1).max(120),
  trainNumber: z.string().min(1).max(40),
  trainType: z.string().min(1).max(20),
  departAt: z.string().min(1).max(20),
  arriveAt: z.string().min(1).max(20),
  fareLabel: z.string().min(1).max(40),
});

const createSchema = z
  .object({
    departure: z.string().min(1),
    arrival: z.string().min(1),
    date: z.string().date("출발일을 올바르게 선택해주세요."),
    timeRangeStart: timeSchema,
    timeRangeEnd: timeSchema,
    passengers: z.coerce.number().int().min(1).max(4),
    seatClassPreference: z.enum(["standard_only", "standard_preferred", "any"]),
    candidates: z.array(candidateSchema).min(1).max(5),
    watchUntil: z.string().datetime({ offset: true }),
    intervalSeconds: z.number().int().min(1).max(5),
  })
  .refine((value) => value.departure !== value.arrival, { message: "출발역과 도착역은 달라야 합니다." })
  .refine((value) => new Date(value.watchUntil).getTime() > Date.now(), { message: "감시 종료시간은 미래여야 합니다." });

const isRateLimited = createRateLimiter(6);

export async function POST(request: NextRequest) {
  // §7 검토사항과 동일한 순서: 운영 환경 차단을 rate limit보다 먼저 확인한다.
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_JOB_INPUT", "자동화 작업 입력값을 확인해주세요.");
    }

    // "official" Provider로는 절대 작업을 만들 수 없다 -- v0.4
    // ReservationJob과 동일한 API 경계 차단(§8 검토사항).
    const providerName = getSeatAutomationProviderName();
    if (providerName === "official") {
      return errorResponse(503, "OFFICIAL_INTEGRATION_REQUIRED", "공식 좌석 자동화 연동은 아직 승인되지 않았습니다.");
    }

    const input = { ...parsed.data, userId: user.id } satisfies AutomationJobInput;
    const job = createJob(input, providerName);
    const response = NextResponse.json({ job }, { status: 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const response = NextResponse.json({ jobs: listJobs(user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}
