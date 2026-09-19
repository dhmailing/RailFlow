import "server-only";

import { getReservationProviderFlag, type ReservationProviderFlag } from "@/lib/reservation/feature-flags";
import { mockReservationProvider } from "@/lib/reservation/mock-reservation-provider";
import { officialReservationProviderStub } from "@/lib/reservation/official-reservation-provider-stub";
import { ReservationProviderError, type RailReservationProvider } from "@/lib/reservation/types";

export function getReservationProviderName(): ReservationProviderFlag {
  return getReservationProviderFlag();
}

export function getReservationProvider(): RailReservationProvider {
  const flag = getReservationProviderFlag();
  if (flag === "mock") return mockReservationProvider;
  if (flag === "official") return officialReservationProviderStub;
  throw new ReservationProviderError(
    "JOBS_DISABLED",
    "예약 Provider가 비활성화되어 있습니다 (RAIL_RESERVATION_PROVIDER=disabled).",
  );
}
