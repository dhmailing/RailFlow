import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { createMemoryRateLimiter } from "@/lib/security/rate-limit";
import { OriginError } from "@/lib/security/origin-guard";
import { AuthError, type AuthErrorCode } from "@/lib/auth/types";
import { AutomationError, type AutomationErrorCode } from "@/lib/automation/types";

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

const STATUS_BY_CODE: Record<AutomationErrorCode, number> = {
  NOT_CONFIGURED: 503,
  OFFICIAL_INTEGRATION_REQUIRED: 503,
  AUTOMATION_TARGET_NOT_ALLOWED: 503,
  INVALID_TRANSITION: 409,
  JOBS_DISABLED: 503,
  DUPLICATE_JOB: 409,
  NOT_FOUND: 404,
  STALE_CLAIM: 409,
  CHECK_FAILED: 502,
  PURCHASE_CLICK_FAILED: 502,
  RESERVE_FAILED: 502,
  SIMULATION_INTERVAL_NOT_ALLOWED: 403,
  INVALID_CANDIDATE: 400,
};

export function automationErrorResponse(error: unknown) {
  if (error instanceof OriginError) {
    return errorResponse(403, error.code, error.message);
  }
  if (error instanceof AuthError) {
    return errorResponse(AUTH_STATUS_BY_CODE[error.code] ?? 401, error.code, error.message);
  }
  if (error instanceof AutomationError) {
    return errorResponse(STATUS_BY_CODE[error.code] ?? 500, error.code, error.message);
  }
  return errorResponse(500, "AUTOMATION_FAILED", "자동화 작업 처리 중 오류가 발생했습니다.");
}

// Mirrors lib/watch/http.ts's isProductionEnvironment()/production*BlockedResponse
// pattern, but keyed on VERCEL_ENV (see feature-flags.ts's
// isRealProductionEnvironment doc comment for why: Preview must stay usable).
export { isRealProductionEnvironment } from "@/lib/automation/feature-flags";

export function productionAutomationBlockedResponse() {
  return errorResponse(503, "JOBS_DISABLED", "자동 좌석조회·예약 매크로는 운영 환경에서 항상 비활성화되어 있습니다.");
}

// Mirrors lib/watch/http.ts's createRateLimiter() thin adapter -- delegates
// to the shared dev/test-only in-process limiter (lib/security/rate-limit.ts).
export function createRateLimiter(limitPerMinute: number) {
  const limiter = createMemoryRateLimiter(limitPerMinute);
  return (request: NextRequest) => limiter.isRateLimited(request);
}
