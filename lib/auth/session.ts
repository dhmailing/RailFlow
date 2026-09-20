import "server-only";

import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE_NAME = "railflow_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function setSessionCookie(token: string, expiresAt: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

// Android/API clients send `Authorization: Bearer <token>`; the web/PWA uses
// the httpOnly cookie instead. Both name the same opaque server-side session
// record (lib/auth/store.ts), so either path is revoked identically by
// deleting that one record -- there is no separate mobile auth system to
// keep in sync.
export function extractSessionToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    return token || null;
  }
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}
