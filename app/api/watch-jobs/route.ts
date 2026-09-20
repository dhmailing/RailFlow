import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { isSeatWatchJobsEnabled } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { getSeatAvailabilityProvider } from "@/lib/watch/seat-provider";
import { createWatchJob, listWatchJobs, recordConsent } from "@/lib/watch/store";
import type { WatchJobInput } from "@/lib/watch/types";

export const dynamic = "force-dynamic";

const stationIdSchema = z.string().regex(/^(NAT[A-Z0-9]+|demo-\d+)$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const candidateSchema = z.object({
  id: z.string().min(1).max(80),
  trainNumber: z.string().min(1).max(40),
  trainType: z.string().min(1).max(20),
  departAt: z.string().datetime({ offset: true }),
  arriveAt: z.string().datetime({ offset: true }),
  mockScenario: z.enum(["seat_after_one_check", "no_seat_ever", "error_on_check"]).optional(),
});

const notificationMethodSchema = z.object({
  channel: z.enum(["fcm", "webpush", "telegram", "email"]),
  deviceId: z.string().min(1).max(120),
});

const createSchema = z
  .object({
    departure: z.string().min(1),
    arrival: z.string().min(1),
    departureId: stationIdSchema,
    arrivalId: stationIdSchema,
    date: z.string().date("출발일을 올바르게 선택해주세요."),
    timeRangeStart: timeSchema,
    timeRangeEnd: timeSchema,
    trainType: z.string().min(1).max(20),
    passengers: z.coerce.number().int().min(1).max(4),
    seatClassPreference: z.enum(["standard_only", "standard_preferred", "any"]),
    candidates: z.array(candidateSchema).min(1).max(5),
    watchUntil: z.string().datetime({ offset: true }),
    notificationMethods: z.array(notificationMethodSchema).min(1).max(4),
  })
  .refine((value) => value.departure !== value.arrival, { message: "출발역과 도착역은 달라야 합니다." })
  .refine((value) => new Date(value.watchUntil).getTime() > Date.now(), { message: "감시 종료시간은 미래여야 합니다." });

const isRateLimited = createRateLimiter(6);

export async function POST(request: NextRequest) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }

  try {
    const user = await requireAuth(request);

    if (!isSeatWatchJobsEnabled()) {
      return errorResponse(503, "JOBS_DISABLED", "취소표 감시 기능이 아직 활성화되지 않았습니다.");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_JOB_INPUT", "감시 작업 입력값을 확인해주세요.");
    }

    const input = { ...parsed.data, userId: user.id } satisfies WatchJobInput;
    const provider = getSeatAvailabilityProvider();
    const job = createWatchJob(input, provider.name);
    recordConsent(user.id, "no_ticket_sale_disclaimer", true);
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return watchErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    return NextResponse.json({ jobs: listWatchJobs(user.id) });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
