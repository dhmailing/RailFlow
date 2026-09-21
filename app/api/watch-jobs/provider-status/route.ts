import { NextResponse } from "next/server";

import {
  getSeatAvailabilityProviderFlag,
  isMockSeatSimulationEnabled,
  isSeatWatchJobsEnabled,
  isWatchStoreUsable,
} from "@/lib/watch/feature-flags";
import { getSeatAvailabilityProvider } from "@/lib/watch/seat-provider";

export const dynamic = "force-dynamic";

// No auth required -- booleans and a capability object only, no job data,
// matching v0.4's /api/reservations/provider-status. Explicitly excluded
// from the Production simulate-route block so the UI can always show an
// honest "공식 좌석정보 Provider가 연결되지 않았습니다" state.
export async function GET() {
  const seatAvailabilityProvider = getSeatAvailabilityProviderFlag();
  const capabilities = getSeatAvailabilityProvider().capabilities();

  const response = NextResponse.json({
    seatAvailabilityProvider,
    seatProviderCapabilities: capabilities,
    jobsEnabled: isSeatWatchJobsEnabled(),
    // §1 검토사항: WATCH_STORE가 usable하지 않으면(운영 환경 등) 감시 작업
    // 생성/기기 등록이 서버에서 항상 503으로 거부된다 -- UI가 폼을 아예 숨기고
    // "준비 중" 안내를 보여줄 수 있도록 별도로 노출한다.
    watchStoreEnabled: isWatchStoreUsable(),
    mockSimulationEnabled: isMockSeatSimulationEnabled() && process.env.NODE_ENV !== "production",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
