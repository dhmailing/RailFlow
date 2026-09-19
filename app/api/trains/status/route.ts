import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const live = Boolean(process.env.DATA_GO_KR_SERVICE_KEY?.trim());
  return NextResponse.json({
    mode: "live",
    configured: live,
    sourceLabel: live ? "국토교통부 TAGO 운행시간표" : "실제 조회 연결 준비 중",
    seatAvailability: false,
  }, {
    headers: { "cache-control": "no-store" },
  });
}
