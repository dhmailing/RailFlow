import { NextRequest } from "next/server";
import { z } from "zod";

import { getAuditStore } from "@/lib/audit/store";
import { isAuthStoreUsable } from "@/lib/auth/feature-flags";
import { authErrorResponse, authJson, errorResponse, loginRateLimiter } from "@/lib/auth/http";
import { getDummyPasswordHash, verifyPassword } from "@/lib/auth/password";
import { setSessionCookie, SESSION_TTL_MS } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { AuthError } from "@/lib/auth/types";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  // §4 검토사항: 운영 환경 차단은 rate limit보다 먼저 확인한다.
  if (!isAuthStoreUsable()) {
    return errorResponse(503, "AUTH_STORE_DISABLED", "계정 저장소가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.");
  }

  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return authErrorResponse(error);
  }

  if (loginRateLimiter.isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_INPUT", "이메일과 비밀번호를 확인해주세요.");
  }

  try {
    const store = getAuthStore();
    const record = await store.findUserByEmail(parsed.data.email);
    // 계정이 없어도 항상 실제 scrypt 비교를 한 번 수행해, "계정 없음"과
    // "비밀번호 틀림" 응답이 처리 시간 차이로도 구분되지 않게 한다.
    const passwordOk = record
      ? await verifyPassword(parsed.data.password, record.passwordHash)
      : await verifyPassword(parsed.data.password, await getDummyPasswordHash());
    if (!record || !passwordOk) {
      throw new AuthError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.");
    }
    // 세션 고정(session fixation) 방지: 로그인 성공 시 항상 새 세션을 서버가
    // 발급한다 -- 클라이언트가 세션 토큰을 지정할 방법 자체가 없다.
    const session = await store.createSession(record.id, SESSION_TTL_MS);
    // §2(2차) 재검토: 자격 증명 검증과 새 세션 생성이 모두 성공한 뒤에만
    // 기록한다 -- 비밀번호가 틀린 시도는 이 줄에 도달하지 않는다(위에서
    // 이미 AuthError를 던지고 끝난다).
    getAuditStore().record(record.id, "user_login", null, null);
    const response = authJson({
      user: { id: record.id, email: record.email, createdAt: record.createdAt },
      expiresAt: session.expiresAt,
    });
    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
