import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getReservationProviderFlag, isReservationJobsEnabled } from "@/lib/reservation/feature-flags";
import { createRateLimiter, DEMO_USER_ID_PATTERN, errorResponse, reservationErrorResponse } from "@/lib/reservation/http";
import { createJob, listJobs } from "@/lib/reservation/job-store";
import type { ReservationJobInput } from "@/lib/reservation/types";

export const dynamic = "force-dynamic";

const stationIdSchema = z.string().regex(/^(NAT[A-Z0-9]+|demo-\d+)$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const candidateSchema = z.object({
  id: z.string().min(1).max(80),
  trainNumber: z.string().min(1).max(40),
  departAt: z.string().datetime({ offset: true }),
  arriveAt: z.string().datetime({ offset: true }),
  mockScenario: z.enum(["seat_after_one_check", "no_seat_ever", "error_on_check", "error_on_reserve"]).optional(),
});

const createSchema = z
  .object({
    userId: z.string().regex(DEMO_USER_ID_PATTERN, "데모 사용자 ID 형식이 올바르지 않습니다."),
    departure: z.string().min(1),
    arrival: z.string().min(1),
    departureId: stationIdSchema,
    arrivalId: stationIdSchema,
    date: z.string().date("출발일을 올바르게 선택해주세요."),
    timeRangeStart: timeSchema,
    timeRangeEnd: timeSchema,
    passengers: z.coerce.number().int().min(1).max(4),
    seatClassPreference: z.enum(["standard_only", "standard_preferred", "any"]),
    candidates: z.array(candidateSchema).min(1).max(5),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .refine((value) => value.departure !== value.arrival, { message: "출발역과 도착역은 달라야 합니다." })
  .refine((value) => new Date(value.expiresAt).getTime() > Date.now(), { message: "만료 시각은 미래여야 합니다." });

const isRateLimited = createRateLimiter(6);

export async function POST(request: NextRequest) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  if (!isReservationJobsEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "예약 작업 기능이 아직 활성화되지 않았습니다.");
  }

  const providerFlag = getReservationProviderFlag();
  if (providerFlag === "disabled") {
    return errorResponse(503, "JOBS_DISABLED", "예약 Provider가 비활성화되어 있습니다 (RAIL_RESERVATION_PROVIDER=disabled).");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_JOB_INPUT", "예약 작업 입력값을 확인해주세요.");
  }

  const input = parsed.data satisfies ReservationJobInput;
  try {
    const job = createJob(input, providerFlag);
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return reservationErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId") ?? "";
  if (!DEMO_USER_ID_PATTERN.test(userId)) {
    return errorResponse(400, "INVALID_USER", "데모 사용자 ID를 확인해주세요.");
  }
  return NextResponse.json({ jobs: listJobs(userId) });
}
