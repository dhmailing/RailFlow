import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/require-auth";
import { isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { createRateLimiter, errorResponse, watchErrorResponse } from "@/lib/watch/http";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";
import { listDevices, recordConsent, registerDevice, toDeviceSummary } from "@/lib/watch/store";

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
  // §1/§4 검토사항: 운영 환경(WATCH_STORE 미연결) 차단은 rate limit보다
  // 먼저 확인한다.
  if (!isWatchStoreUsable()) {
    return errorResponse(503, "WATCH_STORE_DISABLED", "알림 수신 기기 등록 기능이 아직 준비되지 않았습니다.");
  }

  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return watchErrorResponse(error);
  }

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
    // §5 검토사항: 등록 직후에도 원문 token은 절대 반환하지 않는다.
    const response = NextResponse.json({ device: toDeviceSummary(device) }, { status: 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const response = NextResponse.json({ devices: listDevices(user.id).map(toDeviceSummary) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return watchErrorResponse(error);
  }
}
