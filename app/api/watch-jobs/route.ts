import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { isSeatWatchJobsEnabled, isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { getSeatAvailabilityProvider } from "@/lib/watch/seat-provider";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { createWatchJob, listWatchJobs, recordConsent } from "@/lib/watch/store";
import type { WatchJobInput } from "@/lib/watch/types";

export const dynamic = "force-dynamic";

const stationIdSchema = z.string().regex(/^(NAT[A-Z0-9]+|demo-\d+)$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

// candidate.id는 더 이상 클라이언트가 지정하지 않는다 -- 서버가
// crypto.randomUUID()로 생성해 db/postgres의 watch_job_candidates.id(uuid)와
// 타입을 맞춘다(§7). 클라이언트는 출처 쪽 식별자(externalKey)만 보낸다.
const candidateSchema = z.object({
  externalKey: z.string().min(1).max(120),
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
  // §4 검토사항: 운영 환경 차단은 rate limit보다 먼저 확인한다 -- 어차피
  // 거부될 요청 때문에 per-instance 메모리 제한기 버킷을 쓸 이유가 없다.
  if (!isSeatWatchJobsEnabled() || !isWatchStoreUsable()) {
    return errorResponse(503, "JOBS_DISABLED", "취소표 감시 기능이 아직 활성화되지 않았습니다.");
  }

  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return watchErrorResponse(error);
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
      return errorResponse(400, "INVALID_JOB_INPUT", "감시 작업 입력값을 확인해주세요.");
    }

    const input = { ...parsed.data, userId: user.id } satisfies WatchJobInput;
    const provider = getSeatAvailabilityProvider();
    const job = createWatchJob(input, provider.name);
    recordConsent(user.id, "no_ticket_sale_disclaimer", true);
    const response = NextResponse.json({ job }, { status: 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const response = NextResponse.json({ jobs: listWatchJobs(user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}
