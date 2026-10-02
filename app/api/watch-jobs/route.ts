import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { isSeatWatchJobsEnabled, isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { getSeatAvailabilityProvider } from "@/lib/watch/seat-provider";
import { checkSourceConsistency } from "@/lib/rail/candidate-source";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { createWatchJob, listWatchJobs, recordConsent } from "@/lib/watch/store";
import type { WatchJobInput } from "@/lib/watch/types";

export const dynamic = "force-dynamic";

const stationIdSchema = z.string().regex(/^(NAT[A-Z0-9]+|demo-\d+)$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

// candidate.id는 더 이상 클라이언트가 지정하지 않는다 -- 서버가
// crypto.randomUUID()로 생성해 db/postgres의 watch_job_candidates.id(uuid)와
// 타입을 맞춘다(§7). 클라이언트는 출처 쪽 식별자(externalKey)만 보낸다.
const candidateSchema = z
  .object({
    externalKey: z.string().min(1).max(120),
    trainNumber: z.string().min(1).max(40),
    trainType: z.string().min(1).max(20),
    departAt: z.string().datetime({ offset: true }),
    arriveAt: z.string().datetime({ offset: true }),
    // 후보가 어디서 온 값인지. 없으면 거부한다 -- 기본값을 주면 출처를
    // 빠뜨린 요청이 조용히 한쪽으로 분류된다.
    source: z.enum(["demo", "tago"]),
    mockScenario: z.enum(["seat_after_one_check", "no_seat_ever", "error_on_check"]).optional(),
  })
  // 시연 시나리오는 데모 후보에만 붙을 수 있다.
  .refine((value) => !value.mockScenario || value.source === "demo", {
    message: "시연 시나리오는 데모 후보에만 지정할 수 있습니다.",
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

    // 출처 **일관성** 검사. 이것은 진위 검증이 아니다 -- 클라이언트가 보낸
    // "tago" 는 그 열차가 실제로 운행한다는 증거가 못 된다. 여기서 보는 것은
    // 역 ID 형태·후보들의 출처·시연 시나리오가 서로 모순되지 않는가다.
    const consistency = checkSourceConsistency({
      departureId: parsed.data.departureId,
      arrivalId: parsed.data.arrivalId,
      candidateSources: parsed.data.candidates.map((candidate) => candidate.source),
    });
    if (!consistency.ok) {
      return errorResponse(400, "INVALID_CANDIDATE_SOURCE", consistency.reason);
    }

    const provider = getSeatAvailabilityProvider();

    // 실제 시간표 후보는 이 경로로 감시할 수 없다.
    //
    // provider.name 의 타입은 "unavailable" | "mock" 이다 -- 이 경로에 실제
    // 좌석 Provider 는 **존재하지 않는다**(승인된 연동 명세가 없다,
    // docs/V0.12-LIVE-SEAT-QUERY-GATE.md). 그래서 조건부가 아니라 무조건
    // 거부한다. 받아 주면 가상 감시 결과가 실제 열차의 좌석 상태처럼 보인다.
    //
    // 실제 Provider 가 생기면 이 분기를 다시 봐야 한다. 그때 provider.name 의
    // 타입이 늘어나므로, 아래 단정이 타입 검사에서 먼저 걸린다.
    const providerCanReadRealSeats: boolean = provider.name !== "unavailable" && provider.name !== "mock";
    if (consistency.source === "tago" && !providerCanReadRealSeats) {
      return errorResponse(
        422,
        "REAL_SOURCE_UNSUPPORTED",
        "실제 시간표에서 고른 열차는 이 감시 경로로 등록할 수 없습니다. 실제 좌석을 조회하는 승인된 연동이 아직 없습니다.",
      );
    }

    const input = { ...parsed.data, userId: user.id } satisfies WatchJobInput;
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
