import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { createMemoryRateLimiter } from "@/lib/security/rate-limit";
import { OriginError } from "@/lib/security/origin-guard";
import { AuthError, type AuthErrorCode } from "@/lib/auth/types";
import { WatchError, type WatchErrorCode } from "@/lib/watch/types";

export function errorResponse(status: number, code: string, message: string) {
  const response = NextResponse.json({ error: { code, message } }, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

const AUTH_STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  WEAK_PASSWORD: 400,
  AUTH_STORE_DISABLED: 503,
  REAUTH_REQUIRED: 401,
};

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
  WATCH_STORE_DISABLED: 503,
  NOTIFICATION_CHANNEL_MISMATCH: 400,
  INVALID_CANDIDATE: 400,
};

export function watchErrorResponse(error: unknown) {
  if (error instanceof OriginError) {
    return errorResponse(403, error.code, error.message);
  }
  if (error instanceof AuthError) {
    return errorResponse(AUTH_STATUS_BY_CODE[error.code] ?? 401, error.code, error.message);
  }
  if (error instanceof WatchError) {
    return errorResponse(STATUS_BY_CODE[error.code] ?? 500, error.code, error.message);
  }
  return errorResponse(500, "WATCH_FAILED", "취소표 감시 작업 처리 중 오류가 발생했습니다.");
}

// §4 검토사항: lib/security/rate-limit.ts의 공유 구현으로 위임한다 --
// 개발/테스트 전용 per-instance 제한기라는 사실과 신뢰 경계는 그 파일에
// 문서화되어 있다. 이 함수는 기존 라우트들의 `const isRateLimited =
// createRateLimiter(n)` 호출부를 바꾸지 않기 위한 얇은 어댑터일 뿐이다.
export function createRateLimiter(limitPerMinute: number) {
  const limiter = createMemoryRateLimiter(limitPerMinute);
  return (request: NextRequest) => limiter.isRateLimited(request);
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
// not a dev-only one). In practice, WATCH_STORE_DISABLED (lib/watch/store.ts)
// already blocks job/device creation in Production independently of this.
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

export function productionSimulationBlockedResponse() {
  return errorResponse(503, "JOBS_DISABLED", "Mock 취소표 시뮬레이션은 운영 환경에서 항상 비활성화되어 있습니다.");
}
