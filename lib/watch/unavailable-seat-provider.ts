import "server-only";

import type { SeatAvailabilityProvider } from "@/lib/watch/types";

// The default (and Production-only) Seat Availability Provider. No official,
// contracted real-time seat feed exists yet (§1, §3-C) -- this provider
// never opens a network connection and never claims to know whether a seat
// is available. `available: null` + `providerStatus: "unavailable"` is the
// entire contract; a real implementation is the only thing ever allowed to
// return a real boolean.
export const unavailableSeatAvailabilityProvider: SeatAvailabilityProvider = {
  name: "unavailable",

  capabilities() {
    return { supportsAvailabilityCheck: false, simulation: false };
  },

  async checkSeats(job) {
    const checkedAt = new Date().toISOString();
    return job.candidates.map((candidate) => ({
      candidateId: candidate.id,
      available: null,
      providerStatus: "unavailable" as const,
      checkedAt,
      simulation: false,
    }));
  },
};
