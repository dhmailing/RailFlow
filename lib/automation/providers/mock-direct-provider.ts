import "server-only";

import { ensureMockBookingSiteSeeded } from "@/lib/automation/mock-booking-site/seed";
import { checkSeatStatus, getListing, recordPurchaseClick, reserveSeat } from "@/lib/automation/mock-booking-site/store";
import { AutomationError, type SeatAutomationProvider } from "@/lib/automation/types";

// A second, deliberately non-browser Provider for demonstrating the same
// automation job/worker/API path as "mock-browser" on hosts where a real
// Playwright browser cannot run (see docs/V0.7-AUTOMATION-BOUNDARY.md §5 --
// this repository's own Cloudflare Workers build/dev path, and potentially
// a Vercel Edge Function). It reads/writes the exact same
// lib/automation/mock-booking-site/store.ts state that mock-browser-provider.ts
// drives through a real browser and RailFlow's own HTTP API -- so the
// worker/job-store/state-machine code exercises the identical scenario data
// (candidate 1 always sold out, candidate 2 seat at the 3rd check, candidate
// 3 at the 5th) -- just via a direct in-process function call instead of a
// browser click. This is *not* "faking a browser": it never claims to have
// clicked anything, and capabilities().simulation is true so no caller can
// mistake it for the real Playwright automation. It makes zero external
// network calls and never imports `playwright`, so it works in any runtime
// (Node.js or Cloudflare Workers) and is a reliable Provider for demoing on
// Vercel Preview even where mock-browser cannot load (RUNTIME_NOT_SUPPORTED).
export const mockDirectSeatAutomationProvider: SeatAutomationProvider = {
  name: "mock-direct",

  capabilities() {
    return {
      supportsAvailability: true,
      supportsPurchaseClick: true,
      supportsReservation: true,
      supportsCancellation: false,
      simulation: true,
    };
  },

  async searchAvailability({ candidate }) {
    ensureMockBookingSiteSeeded();
    if (!getListing(candidate.id)) {
      throw new AutomationError("INVALID_CANDIDATE", `등록되지 않은 Mock 예매 사이트 후보입니다: ${candidate.id}`);
    }
    const status = checkSeatStatus(candidate.id);
    return {
      candidateId: candidate.id,
      available: status.standardSeats > 0 || status.specialSeats > 0,
      seatClass: status.standardSeats > 0 ? ("standard" as const) : status.specialSeats > 0 ? ("special" as const) : null,
      definitiveSoldOut: status.definitiveSoldOut,
      checkedAt: status.checkedAt,
      simulation: true,
    };
  },

  async clickPurchase({ candidateId }) {
    ensureMockBookingSiteSeeded();
    if (!getListing(candidateId)) {
      throw new AutomationError("INVALID_CANDIDATE", `등록되지 않은 Mock 예매 사이트 후보입니다: ${candidateId}`);
    }
    recordPurchaseClick(candidateId);
    return { clicked: true, clickedAt: new Date().toISOString(), simulation: true };
  },

  async reserve({ candidateId, idempotencyKey }) {
    ensureMockBookingSiteSeeded();
    if (!getListing(candidateId)) {
      throw new AutomationError("INVALID_CANDIDATE", `등록되지 않은 Mock 예매 사이트 후보입니다: ${candidateId}`);
    }
    // reserveSeat() itself re-derives current availability without
    // advancing checkCount (see store.ts's checkSeatStatusWithoutAdvancing,
    // not exported) -- so unlike searchAvailability/clickPurchase above,
    // this never calls checkSeatStatus() again here. It tries "standard"
    // first, falling back to "special", exactly mirroring the client-side
    // choice booking-simulator.tsx's own reserve() makes from its
    // already-fetched status.
    let reservation;
    try {
      reservation = reserveSeat({ listingId: candidateId, seatClass: "standard", idempotencyKey });
    } catch {
      try {
        reservation = reserveSeat({ listingId: candidateId, seatClass: "special", idempotencyKey });
      } catch (error) {
        const message = error instanceof Error ? error.message : "예약 요청 중 오류가 발생했습니다.";
        throw new AutomationError("RESERVE_FAILED", message);
      }
    }
    return {
      reserved: true,
      candidateId,
      reservationNumber: reservation.reservationNumber,
      paymentDeadline: reservation.paymentDeadline,
      simulation: true,
    };
  },

  async getReservation({ job }) {
    return { status: job.status, reservationNumber: job.reservationNumber, simulation: true };
  },

  async cancelReservation() {
    throw new AutomationError("NOT_CONFIGURED", "Mock 예약 취소는 아직 구현되지 않았습니다.");
  },
};
