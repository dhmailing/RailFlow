import { NextRequest, NextResponse } from "next/server";

import { DEMO_USER_ID_PATTERN, errorResponse, reservationErrorResponse } from "@/lib/reservation/http";
import { getJob } from "@/lib/reservation/job-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = request.nextUrl.searchParams.get("userId") ?? "";
  if (!DEMO_USER_ID_PATTERN.test(userId)) {
    return errorResponse(400, "INVALID_USER", "데모 사용자 ID를 확인해주세요.");
  }

  try {
    return NextResponse.json({ job: getJob(id, userId) });
  } catch (error) {
    return reservationErrorResponse(error);
  }
}
