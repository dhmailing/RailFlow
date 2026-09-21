import { NextRequest } from "next/server";

import { getAuditStore } from "@/lib/audit/store";
import { authErrorResponse, authJson } from "@/lib/auth/http";
import { isAuthStoreUsable } from "@/lib/auth/feature-flags";
import { clearSessionCookie, extractSessionToken } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return authErrorResponse(error);
  }

  const token = extractSessionToken(request);
  // 저장소가 비활성 상태(production 등)여도 로그아웃(쿠키 제거) 자체는 항상
  // 성공해야 한다 -- 세션 삭제가 불가능하다고 사용자를 쿠키만 남은 채로
  // 가두면 안 된다.
  if (token && isAuthStoreUsable()) {
    const store = getAuthStore();
    // §2(2차) 재검토: "유효한 세션의 사용자를 확인한 뒤" 감사 이벤트를
    // 남긴다 -- 어떤 사용자였는지 알아야 어느 userId로 기록할지 정할 수
    // 있고, 이미 만료·존재하지 않는 세션(쿠키만 남은 재호출 등)에는 가짜
    // 성공 이벤트를 남기지 않는다는 뜻이기도 하다. 두 번째 로그아웃 호출이나
    // 세션이 아예 없는 호출은 이 블록을 건너뛰므로 중복 이벤트가 쌓이지
    // 않는다.
    const session = await store.getSession(token);
    await store.deleteSession(token);
    if (session) {
      getAuditStore().record(session.userId, "user_logout", null, null);
    }
  }
  const response = authJson({ loggedOut: true });
  clearSessionCookie(response);
  return response;
}
