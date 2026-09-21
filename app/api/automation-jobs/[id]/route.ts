import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { assertTrustedOrigin } from "@/lib/security/origin-guard";

import { isRealProductionEnvironment } from "@/lib/automation/feature-flags";
import { automationErrorResponse, createRateLimiter, errorResponse } from "@/lib/automation/http";
import { deleteJob, getJob } from "@/lib/automation/job-store";
import { isTerminalStatus } from "@/lib/automation/state-machine";
import { AutomationError } from "@/lib/automation/types";

export const dynamic = "force-dynamic";

const isRateLimited = createRateLimiter(30);

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    const response = NextResponse.json({ job: getJob(id, user.id) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}

// "작업 삭제"(§5 UI) -- 진행 중인 작업은 삭제할 수 없다. 먼저 "감시 중지"로
// CANCELLED(또는 다른 terminal 상태)로 만든 뒤에만 삭제할 수 있다 -- 실행
// 중인 작업이 조용히 사라지는 것을 막는다.
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (isRealProductionEnvironment()) {
    return errorResponse(503, "JOBS_DISABLED", "자동 좌석조회·예약 매크로가 운영 환경에서 비활성화되어 있습니다.");
  }
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
    const job = getJob(id, user.id);
    if (!isTerminalStatus(job.status)) {
      throw new AutomationError("INVALID_TRANSITION", "진행 중인 작업은 삭제할 수 없습니다. 먼저 감시를 중지해주세요.");
    }
    deleteJob(id, user.id);
    const response = NextResponse.json({ deleted: true });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return automationErrorResponse(error);
  }
}
