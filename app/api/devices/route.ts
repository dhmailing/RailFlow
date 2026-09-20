import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { listDevices, recordConsent, registerDevice } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  channel: z.enum(["fcm", "webpush", "telegram", "email"]),
  token: z.string().min(1).max(4096),
  label: z.string().max(80).optional(),
});

const isRateLimited = createRateLimiter(20);

// Registers a notification destination (FCM token, WebPush subscription,
// Telegram chat id, or email address). A successful call implies the user
// granted notification permission for this device -- recorded as a
// ConsentHistory row (§3-B entity list) rather than inferred silently.
export async function POST(request: NextRequest) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_BODY", "요청 본문을 확인해주세요.");
    }
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_INPUT", "알림 채널과 토큰 값을 확인해주세요.");
    }
    const device = registerDevice(user.id, parsed.data.channel, parsed.data.token, parsed.data.label ?? null);
    recordConsent(user.id, "notification_permission", true);
    return NextResponse.json({ device }, { status: 201 });
  } catch (error) {
    return watchErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    return NextResponse.json({ devices: listDevices(user.id) });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
