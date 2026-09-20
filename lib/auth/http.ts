import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { AuthError, type AuthErrorCode } from "@/lib/auth/types";

export function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  WEAK_PASSWORD: 400,
};

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return errorResponse(STATUS_BY_CODE[error.code] ?? 401, error.code, error.message);
  }
  return errorResponse(500, "AUTH_FAILED", "인증 처리 중 오류가 발생했습니다.");
}

// Same shape as lib/reservation/http.ts's limiter -- kept as its own small
// copy rather than a shared import so the auth and watch modules stay
// independently deployable/removable, matching this repo's existing
// per-module convention (app/api/trains/search/route.ts has its own too).
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
