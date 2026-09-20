import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse } from "@/lib/auth/http";
import { requireAuth } from "@/lib/auth/require-auth";
import { clearSessionCookie } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { deleteAllWatchDataForUser } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

// §6 보안 요구사항: 사용자 데이터 삭제 기능. Deletes the account, every
// session, and every WatchJob/Device/NotificationDelivery/ConsentHistory row
// owned by this user (audit events are kept -- see lib/watch/store.ts for why).
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    await deleteAllWatchDataForUser(user.id);
    await getAuthStore().deleteUser(user.id);
    await clearSessionCookie();
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
