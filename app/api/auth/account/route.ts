import { NextRequest } from "next/server";
import { z } from "zod";

import { getAuditStore } from "@/lib/audit/store";
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
// lib/audit/ 참고).
//
// §3(2차) 재검토: 순서가 중요하다.
//   1. "user_deleted" 이벤트를 먼저 기록한다.
//   2. 이 사용자의 모든 이벤트(방금 기록한 것 포함)를 하나의 공통 가명으로
//      치환한다 -- 1)을 먼저 하지 않으면 user_deleted만 다른 가명을 받는다.
//   3. watch/device/알림/동의 데이터를 실제로 삭제한다.
//   4. 세션과 계정 자체를 삭제한다.
// 재인증에 실패한 요청은 이 함수에 도달하지 않으므로 삭제 이벤트가 남지
// 않는다(아래에서 REAUTH_REQUIRED를 먼저 던진다).
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

    const auditStore = getAuditStore();
    auditStore.record(user.id, "user_deleted", null, null);
    auditStore.pseudonymizeForUser(user.id);
    await deleteAllWatchDataForUser(user.id);
    await store.deleteUser(user.id);
    const response = authJson({ deleted: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
