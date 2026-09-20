import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, createRateLimiter, errorResponse } from "@/lib/auth/http";
import { verifyPassword } from "@/lib/auth/password";
import { setSessionCookie, SESSION_TTL_MS } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";
import { AuthError } from "@/lib/auth/types";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

const isRateLimited = createRateLimiter(10);

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

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_INPUT", "이메일과 비밀번호를 확인해주세요.");
  }

  try {
    const store = getAuthStore();
    const record = await store.findUserByEmail(parsed.data.email);
    // Same error for "no such user" and "wrong password" -- never reveal
    // which one it was.
    if (!record || !(await verifyPassword(parsed.data.password, record.passwordHash))) {
      throw new AuthError("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.");
    }
    const session = await store.createSession(record.id, SESSION_TTL_MS);
    await setSessionCookie(session.token, session.expiresAt);
    return NextResponse.json({
      user: { id: record.id, email: record.email, createdAt: record.createdAt },
      token: session.token,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
