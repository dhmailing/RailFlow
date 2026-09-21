import "server-only";

import type { NextRequest, NextResponse } from "next/server";

const BASE_COOKIE_NAME = "railflow_session";

// __Host- 접두사는 브라우저가 Secure + Path=/ + Domain 미설정을 강제하게
// 만드는 추가 방어선이다 (이 오리진에만 쿠키 스코프를 고정). 운영(prod)에서만
// 사용한다 -- 로컬 http 개발 서버는 Secure 쿠키를 저장하지 못해 즉시 로그인이
// 깨지므로 개발 환경에서는 접두사 없는 이름을 그대로 쓴다.
export function getSessionCookieName(): string {
  return process.env.NODE_ENV === "production" ? `__Host-${BASE_COOKIE_NAME}` : BASE_COOKIE_NAME;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// next/headers의 cookies()는 Next의 실제 요청 파이프라인(AsyncLocalStorage)
// 밖에서는 동작하지 않아 오프라인 테스트 스크립트에서 매번 스텁이 필요했다.
// 대신 호출자가 만든 NextResponse에 직접 쓰도록 바꿔 실제 Set-Cookie 헤더를
// 그대로 검증할 수 있게 한다 (scripts/verify-seat-watch.cjs 참고).
export function setSessionCookie(response: NextResponse, token: string, expiresAt: string): void {
  response.cookies.set(getSessionCookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.delete({ name: getSessionCookieName(), path: "/" });
}

// 쿠키 전용. 이전에는 Authorization: Bearer도 허용했지만, 이번 PR은
// Android에 적합한 토큰 인증 방식(회전, 폐기, 안전한 저장소)을 설계하지
// 않았으므로 제거했다 -- 네이티브 클라이언트를 붙일 때는 이 웹 세션 쿠키를
// 그대로 재사용하지 말고 별도로 설계해야 한다 (docs/adr/0002 참고).
export function extractSessionToken(request: NextRequest): string | null {
  return request.cookies.get(getSessionCookieName())?.value ?? null;
}
