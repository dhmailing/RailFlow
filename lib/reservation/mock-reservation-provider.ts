import "server-only";

import {
  ReservationProviderError,
  type RailReservationProvider,
} from "@/lib/reservation/types";

// Never contacts any external URL. All outcomes are derived only from the
// TrainCandidate.mockScenario the job was created with (§ types.ts), so a
// test author fully controls the seat-none -> seat-appears -> HELD flow
// without any network dependency. Scenarios are evaluated against
// job.attempts (a global per-job counter incremented by the Worker after
// every checkAvailability call), which is exact for the common single-
// candidate job and simply cycles for a multi-candidate job.
export const mockReservationProvider: RailReservationProvider = {
  name: "mock",

  capabilities() {
    return {
      supportsAvailability: true,
      supportsHold: true,
      supportsPayment: false,
      supportsCancellation: true,
      simulation: true,
    };
  },

  async checkAvailability(job) {
    if (job.candidates.length === 0) {
      throw new ReservationProviderError("CHECK_FAILED", "확인할 후보 열차가 없습니다.");
    }
    const candidate = job.candidates[job.attempts % job.candidates.length];
    const checkedAt = new Date().toISOString();

    if (candidate.mockScenario === "error_on_check") {
      throw new ReservationProviderError(
        "CHECK_FAILED",
        `Mock 시나리오(error_on_check)로 좌석 확인에 실패했습니다: ${candidate.trainNumber}`,
      );
    }

    const available =
      candidate.mockScenario === "no_seat_ever"
        ? false
        : candidate.mockScenario === "seat_after_one_check"
          ? job.attempts >= 1
          : true;

    return { candidateId: candidate.id, available, checkedAt, simulation: true };
  },

  async reserve(job, candidateId) {
    const candidate = job.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new ReservationProviderError("RESERVE_FAILED", "선택한 후보 열차를 찾을 수 없습니다.");
    }
    if (candidate.mockScenario === "error_on_reserve") {
      throw new ReservationProviderError(
        "RESERVE_FAILED",
        `Mock 시나리오(error_on_reserve)로 예약에 실패했습니다: ${candidate.trainNumber}`,
      );
    }

    const holdExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    return { held: true, candidateId, holdExpiresAt, simulation: true };
  },

  async getReservation(job) {
    return { status: job.status, heldCandidateId: job.heldCandidateId, simulation: true };
  },

  async cancel() {
    return { cancelled: true, simulation: true };
  },
};
