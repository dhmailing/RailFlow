import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, createRateLimiter, errorResponse } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie, SESSION_TTL_MS } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";

export const dynamic = "force-dynamic";

const signupSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});

const isRateLimited = createRateLimiter(5);

export async function POST(request: NextRequest) {
  if (isRateLimited(request)) {
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
    await setSessionCookie(session.token, session.expiresAt);
    return NextResponse.json({ user, token: session.token, expiresAt: session.expiresAt }, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
