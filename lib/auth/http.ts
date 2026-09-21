import "server-only";

import { NextResponse } from "next/server";

import { OriginError } from "@/lib/security/origin-guard";
import { createMemoryRateLimiter } from "@/lib/security/rate-limit";
import { AuthError, type AuthErrorCode } from "@/lib/auth/types";

// 인증 응답은 세션 상태나 계정 정보를 담는다 -- 공유 캐시/CDN/브라우저
// bfcache가 다른 사용자에게 같은 기기에서 이전 응답을 재사용해 보여주면
// 안 되므로 항상 no-store를 강제한다.
function withNoStore<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function errorResponse(status: number, code: string, message: string) {
  return withNoStore(NextResponse.json({ error: { code, message } }, { status }));
}

export function authJson<T>(body: T, init?: { status?: number }) {
  return withNoStore(NextResponse.json(body, init));
}

const STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  WEAK_PASSWORD: 400,
  AUTH_STORE_DISABLED: 503,
  REAUTH_REQUIRED: 401,
};

export function authErrorResponse(error: unknown) {
  if (error instanceof OriginError) {
    return errorResponse(403, error.code, error.message);
  }
  if (error instanceof AuthError) {
    return errorResponse(STATUS_BY_CODE[error.code] ?? 401, error.code, error.message);
  }
  return errorResponse(500, "AUTH_FAILED", "인증 처리 중 오류가 발생했습니다.");
}

// §4 검토사항: 개발/테스트 전용 per-instance 제한기다. Vercel Serverless에서는
// 인스턴스마다 별도 메모리를 가지므로 실제 운영 제한으로 취급하지 않는다 --
// 자세한 내용과 신뢰 경계는 lib/security/rate-limit.ts 참고. 실제 운영
// 배포에서는 AUTH_STORE가 fail-closed로 막혀 있으므로(§1) 이 라우트들 자체가
// production에서 503으로 차단된다.
export const signupRateLimiter = createMemoryRateLimiter(5);
export const loginRateLimiter = createMemoryRateLimiter(10);
