import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { ReservationProviderError, type ReservationErrorCode } from "@/lib/reservation/types";

export function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const STATUS_BY_CODE: Record<ReservationErrorCode, number> = {
  NOT_CONFIGURED: 503,
  OFFICIAL_INTEGRATION_REQUIRED: 503,
  INVALID_TRANSITION: 409,
  SIMULATION_INTERVAL_NOT_ALLOWED: 403,
  PROVIDER_MISMATCH: 409,
  JOBS_DISABLED: 503,
  DUPLICATE_JOB: 409,
  NOT_FOUND: 404,
  CHECK_FAILED: 502,
  RESERVE_FAILED: 502,
};

export function reservationErrorResponse(error: unknown) {
  if (error instanceof ReservationProviderError) {
    return errorResponse(STATUS_BY_CODE[error.code] ?? 500, error.code, error.message);
  }
  return errorResponse(500, "RESERVATION_FAILED", "예약 작업 처리 중 오류가 발생했습니다.");
}

// Same shape as app/api/trains/search/route.ts's limiter, kept separate
// because job-mutating endpoints (create/cancel/simulate) get their own,
// stricter bucket rather than sharing search traffic's budget.
export function createRateLimiter(limitPerMinute: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function isRateLimited(request: NextRequest): boolean {
    const clientId =
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0] ??
      "anonymous";
    const now = Date.now();
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
    const bucket = buckets.get(clientId);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(clientId, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > limitPerMinute;
  };
}

// v0.4 has no auth yet, so every user-supplied id is scoped to this demo
// namespace and validated on every request rather than trusted from the client.
export const DEMO_USER_ID_PATTERN = /^demo-[a-zA-Z0-9_-]{1,40}$/;

// Every Demo reservation-job route (create/list/detail/cancel/simulate --
// everything except provider-status, which returns no job data) must refuse
// to run in production, independent of RAIL_RESERVATION_PROVIDER/
// ENABLE_RESERVATION_JOBS/ENABLE_MOCK_SIMULATION. There is no user
// authentication yet: `userId` is a client-generated `demo-*` string, so this
// is a second, unconditional lock in front of those flags rather than a
// substitute for one of them. TODO(v0.5+): once real user accounts exist,
// replace this blanket production block with per-user authentication and
// authorization instead of removing it outright.
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

export function productionBlockedResponse() {
  return errorResponse(
    503,
    "JOBS_DISABLED",
    "인증 도입 전까지 Demo 예약 작업 API는 운영 환경에서 항상 비활성화되어 있습니다.",
  );
}
