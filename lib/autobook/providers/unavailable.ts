import "server-only";

import { AutobookError, type SeatReservationProvider } from "@/lib/autobook/types";

// 운영 기본값.
//
// "아직 연동이 없다"를 조용히 실패로 숨기지 않고, 모든 호출에서 같은
// 오류를 던져 화면이 `공식 연동 준비 중`을 표시하게 한다.

export const unavailableProvider: SeatReservationProvider = {
  name: "unavailable",
  capabilities: () => ({
    canReadAvailability: false,
    canCreateReservation: false,
    canVerifyReservation: false,
    simulation: false,
  }),
  checkAvailability: () =>
    Promise.reject(
      new AutobookError(
        "PROVIDER_UNAVAILABLE",
        "실제 좌석 조회 연동이 아직 없습니다. 공식·승인된 연동 경로가 확인되면 활성화됩니다.",
      ),
    ),
  createReservation: () =>
    Promise.reject(
      new AutobookError("PROVIDER_UNAVAILABLE", "실제 예약 연동이 아직 없습니다."),
    ),
  findExistingReservation: () =>
    Promise.reject(
      new AutobookError("PROVIDER_UNAVAILABLE", "실제 예약 조회 연동이 아직 없습니다."),
    ),
};
