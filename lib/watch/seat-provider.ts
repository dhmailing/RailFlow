import "server-only";

import { getSeatAvailabilityProviderFlag } from "@/lib/watch/feature-flags";
import { mockSeatAvailabilityProvider } from "@/lib/watch/mock-seat-provider";
import { unavailableSeatAvailabilityProvider } from "@/lib/watch/unavailable-seat-provider";
import type { SeatAvailabilityProvider } from "@/lib/watch/types";

export function getSeatAvailabilityProvider(): SeatAvailabilityProvider {
  return getSeatAvailabilityProviderFlag() === "mock" ? mockSeatAvailabilityProvider : unavailableSeatAvailabilityProvider;
}
