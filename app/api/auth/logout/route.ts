import { NextRequest } from "next/server";

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
    await getAuthStore().deleteSession(token);
  }
  const response = authJson({ loggedOut: true });
  clearSessionCookie(response);
  return response;
}
