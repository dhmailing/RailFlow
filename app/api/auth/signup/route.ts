import { NextRequest } from "next/server";
import { z } from "zod";

import { getAuditStore } from "@/lib/audit/store";
import { isAuthStoreUsable } from "@/lib/auth/feature-flags";
import { authErrorResponse, authJson, errorResponse, signupRateLimiter } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie, SESSION_TTL_MS } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

export const dynamic = "force-dynamic";

const signupSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});

export async function POST(request: NextRequest) {
  // §4 검토사항: 운영 환경 차단은 rate limit보다 먼저 확인한다 -- 어차피
  // 거부될 요청 때문에 per-instance 메모리 제한기 버킷을 쓸 이유가 없다.
  if (!isAuthStoreUsable()) {
    return errorResponse(503, "AUTH_STORE_DISABLED", "계정 저장소가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.");
  }

  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return authErrorResponse(error);
  }

  if (signupRateLimiter.isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_INPUT", "이메일 형식과 8자 이상의 비밀번호를 확인해주세요.");
  }

  try {
    const store = getAuthStore();
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await store.createUser(parsed.data.email, passwordHash);
    const session = await store.createSession(user.id, SESSION_TTL_MS);
    // §2(2차) 재검토: 계정과 세션이 모두 성공적으로 만들어진 뒤에만 기록한다
    // -- 이메일 중복 등으로 가입이 실패한 요청은 여기 도달하지 않는다.
    // 이메일 원문·비밀번호·세션 토큰은 metadata에 절대 넣지 않는다.
    getAuditStore().record(user.id, "user_signup", null, null);
    // 세션 토큰은 JSON 본문으로 절대 반환하지 않는다 -- httpOnly 쿠키로만
    // 전달한다 (§2 검토사항).
    const response = authJson({ user, expiresAt: session.expiresAt }, { status: 201 });
    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
