import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { AuthError } from "@/lib/auth/types";
import { WatchError, type WatchErrorCode } from "@/lib/watch/types";

export function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const STATUS_BY_CODE: Record<WatchErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE_JOB: 409,
  INVALID_TRANSITION: 409,
  JOBS_DISABLED: 503,
  PROVIDER_UNAVAILABLE: 200, // not an error the client needs to branch on -- see routes
  SIMULATION_NOT_ALLOWED: 403,
  CHECK_FAILED: 502,
  NOTIFICATION_NOT_CONFIGURED: 503,
  INVALID_DEVICE: 400,
};

export function watchErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return errorResponse(401, error.code, error.message);
  }
  if (error instanceof WatchError) {
    return errorResponse(STATUS_BY_CODE[error.code] ?? 500, error.code, error.message);
  }
  return errorResponse(500, "WATCH_FAILED", "취소표 감시 작업 처리 중 오류가 발생했습니다.");
}

// Same shape as lib/reservation/http.ts / lib/auth/http.ts -- kept as its own
// copy per this repo's existing per-module convention.
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

// Every Demo-era lesson from v0.4 applies here too, except this module never
// had a "demo" scope to begin with -- every watch-job/device route requires
// a real authenticated session (lib/auth/require-auth.ts) from day one. This
// guard is the extra, unconditional Production lock in front of the feature
// flags (ENABLE_SEAT_WATCH_JOBS, SEAT_AVAILABILITY_PROVIDER,
// ENABLE_MOCK_SEAT_SIMULATION), applied only to the Mock-simulation route --
// job CRUD itself is allowed in Production once authenticated, since a user
// may legitimately register a watch intent before any Seat Availability
// Provider is connected (PROVIDER_UNAVAILABLE is a real, user-facing state,
// not a dev-only one).
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

export function productionSimulationBlockedResponse() {
  return errorResponse(503, "JOBS_DISABLED", "Mock 취소표 시뮬레이션은 운영 환경에서 항상 비활성화되어 있습니다.");
}
