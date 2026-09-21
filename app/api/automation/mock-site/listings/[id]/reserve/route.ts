import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/automation/http";
import { isMockBookingSiteEnabled } from "@/lib/automation/feature-flags";
import { ensureMockBookingSiteSeeded } from "@/lib/automation/mock-booking-site/seed";
import { reserveSeat } from "@/lib/automation/mock-booking-site/store";

export const dynamic = "force-dynamic";

const reserveSchema = z.object({
  seatClass: z.enum(["standard", "special"]),
  idempotencyKey: z.string().min(1).max(200),
});

// (§6 동시성) idempotencyKey makes a retried POST (e.g. the automation
// Worker retrying after a dropped response) return the exact same
// reservation instead of creating a second one -- see
// lib/automation/mock-booking-site/store.ts's reserveSeat().
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isMockBookingSiteEnabled()) {
    return errorResponse(503, "JOBS_DISABLED", "Mock 예매 시뮬레이터가 이 환경에서 비활성화되어 있습니다.");
  }
  ensureMockBookingSiteSeeded();
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_BODY", "seatClass와 idempotencyKey가 필요합니다.");
  }

  try {
    const reservation = reserveSeat({ listingId: id, seatClass: parsed.data.seatClass, idempotencyKey: parsed.data.idempotencyKey });
    const response = NextResponse.json({ reservation });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "SOLD_OUT_AT_RESERVE") {
      return errorResponse(409, "RESERVE_FAILED", "예약 시점에 좌석이 이미 소진되었습니다.");
    }
    return errorResponse(404, "NOT_FOUND", "해당 열차를 찾을 수 없습니다.");
  }
}
