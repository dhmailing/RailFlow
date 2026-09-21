import "server-only";

import { WatchError, type SeatAvailabilityProvider } from "@/lib/watch/types";

// Dev/test only (fail-closed everywhere else -- see feature-flags.ts and
// simulation-guard.ts). Never opens a network connection; every outcome
// comes only from TrainCandidate.mockScenario (types.ts), evaluated against
// job.attempts, exactly like v0.4's mock-reservation-provider.ts. One tick
// checks exactly one candidate, cycling through job.candidates by
// job.attempts % length.
export const mockSeatAvailabilityProvider: SeatAvailabilityProvider = {
  name: "mock",

  capabilities() {
    return { supportsAvailabilityCheck: true, simulation: true };
  },

  async checkSeats(job) {
    if (job.candidates.length === 0) {
      throw new WatchError("CHECK_FAILED", "확인할 후보 열차가 없습니다.");
    }
    const candidate = job.candidates[job.attempts % job.candidates.length];
    const checkedAt = new Date().toISOString();

    if (candidate.mockScenario === "error_on_check") {
      throw new WatchError("CHECK_FAILED", `Mock 시나리오(error_on_check)로 좌석 확인에 실패했습니다: ${candidate.trainNumber}`);
    }

    const available =
      candidate.mockScenario === "no_seat_ever"
        ? false
        : candidate.mockScenario === "seat_after_one_check"
          ? job.attempts >= 1
          : true;

    return [{ candidateId: candidate.id, available, providerStatus: "ok", checkedAt, simulation: true }];
  },
};
