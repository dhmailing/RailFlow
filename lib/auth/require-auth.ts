import "server-only";

import type { NextRequest } from "next/server";

import { getAuthStore } from "@/lib/auth/store";
import { extractSessionToken } from "@/lib/auth/session";
import { AuthError, type AuthUser } from "@/lib/auth/types";

// The single gate every watch-job route calls before touching any data.
// Throws AuthError (never returns a fallback/demo user) so callers cannot
// accidentally treat "not authenticated" as "authenticated as someone".
export async function requireAuth(request: NextRequest): Promise<AuthUser> {
  const token = extractSessionToken(request);
  if (!token) {
    throw new AuthError("UNAUTHENTICATED", "로그인이 필요합니다.");
  }
  const store = getAuthStore();
  const session = await store.getSession(token);
  if (!session) {
    throw new AuthError("SESSION_EXPIRED", "세션이 만료됐습니다. 다시 로그인해주세요.");
  }
  const user = await store.findUserById(session.userId);
  if (!user) {
    throw new AuthError("UNAUTHENTICATED", "사용자를 찾을 수 없습니다.");
  }
  return user;
}
