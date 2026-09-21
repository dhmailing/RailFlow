import { NextRequest } from "next/server";
import { z } from "zod";

import { authErrorResponse, authJson, errorResponse } from "@/lib/auth/http";
import { verifyPassword } from "@/lib/auth/password";
import { requireAuth } from "@/lib/auth/require-auth";
import { clearSessionCookie } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { AuthError } from "@/lib/auth/types";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { deleteAllWatchDataForUser } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(200),
});

// §6 보안 요구사항: 사용자 데이터 삭제 기능. 세션이 남아있다는 사실만으로
// 즉시 삭제하지 않고, 비밀번호 재확인을 요구한다 -- 클라이언트 쪽 confirm
// 대화상자는 보안 장치가 아니므로 서버가 다시 검증한다. 통과하면 이 계정의
// 모든 세션, 그리고 이 사용자가 소유한 모든 WatchJob/Device/
// NotificationDelivery/ConsentHistory 행을 삭제한다(감사 이벤트는 보존 --
// lib/watch/store.ts 참고).
export async function DELETE(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
    const user = await requireAuth(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_BODY", "비밀번호를 다시 입력해주세요.");
    }
    const parsed = deleteAccountSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_INPUT", "비밀번호를 다시 입력해주세요.");
    }

    const store = getAuthStore();
    const record = await store.findUserByEmail(user.email);
    if (!record || !(await verifyPassword(parsed.data.password, record.passwordHash))) {
      throw new AuthError("REAUTH_REQUIRED", "비밀번호가 일치하지 않습니다.");
    }

    await deleteAllWatchDataForUser(user.id);
    await store.deleteUser(user.id);
    const response = authJson({ deleted: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
