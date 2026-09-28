import "server-only";

import { getAutobookProviderFlag } from "@/lib/autobook/feature-flags";
import { mockServerProvider } from "@/lib/autobook/providers/mock-server";
import { officialApprovedStubProvider } from "@/lib/autobook/providers/official-approved-stub";
import { unavailableProvider } from "@/lib/autobook/providers/unavailable";
import type { SeatReservationProvider } from "@/lib/autobook/types";

/**
 * 지금 쓸 Provider 를 고른다.
 *
 * 플래그가 fail-closed 이므로(lib/autobook/feature-flags.ts) 값이 없거나
 * 이상하면 항상 unavailable 이 된다. Production 에서는 mock-server 가
 * 선택될 수 없다.
 */
export function getSeatReservationProvider(): SeatReservationProvider {
  switch (getAutobookProviderFlag()) {
    case "mock-server":
      return mockServerProvider;
    case "official-approved":
      return officialApprovedStubProvider;
    default:
      return unavailableProvider;
  }
}
