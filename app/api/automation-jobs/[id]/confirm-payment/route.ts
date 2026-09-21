import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

import { automationErrorResponse, createRateLimiter, errorResponse } from "@/lib/automation/http";
import { transitionJob } from "@/lib/automation/job-store";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(12);

// 결제 완료는 오직 사용자의 명시적 확인으로만 이뤄진다(§ 절대 자동 추정
// 금지). RailFlow는 실제 결제를 수행하지 않는다 -- 이 버튼은 "코레일+에서
// 결제를 마쳤다"는 사용자의 진술을 기록만 한다(v0.4 ReservationJob의
// PAYMENT_PENDING -> COMPLETED와 동일한 원칙).
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedOrigin(request);
  } catch (error) {
    return automationErrorResponse(error);
  }
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
  }
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    const job = transitionJob(id, user.id, "COMPLETED", "사용자가 결제 완료를 확인했습니다.");
    const response = NextResponse.json({ job });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}
