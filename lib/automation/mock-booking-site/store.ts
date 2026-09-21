import "server-only";

// RailFlow's own fake railway-booking site (§3-A). This is the ONLY thing
// the automation Worker's browser is ever allowed to talk to (see
// lib/automation/host-guard.ts) -- it never resembles KORAIL's actual logo,
// branding, or screen layout (app/demo/booking-simulator renders it with
// RailFlow's own black/orange design), and every train number, seat count,
// and reservation it produces is fabricated here in process memory. No
// network call of any kind happens inside this file.
//
// Determinism (§3-A): every listing's seat count is a pure function of how
// many times its GET-status endpoint has been called (`checkCount`), never
// of wall-clock time or randomness -- see MockBookingScenario in
// lib/automation/types.ts. The three example scenarios from the spec
// (always sold out / seat on the 3rd check / seat on the 5th check) are
// exactly what scripts/verify-booking-simulator.cjs exercises.
import type { MockBookingScenario } from "@/lib/automation/types";

export type MockListing = {
  id: string;
  trainNumber: string;
  trainType: string;
  departAt: string;
  arriveAt: string;
  fareLabel: string;
  scenario: MockBookingScenario;
  checkCount: number;
};

export type MockSeatStatus = {
  listingId: string;
  standardSeats: number;
  specialSeats: number;
  soldOut: boolean;
  definitiveSoldOut: boolean;
  checkedAt: string;
  checkCount: number;
  // Server-persisted (not client React state) so a fresh page load/
  // navigation -- exactly what happens between the mock-browser Provider's
  // separate clickPurchase() and reserve() calls -- still shows the
  // "예약 요청" button after a purchase click already happened. See
  // recordPurchaseClick() below.
  purchaseClicked: boolean;
};

export type MockReservation = {
  id: string;
  listingId: string;
  seatClass: "standard" | "special";
  reservationNumber: string;
  paymentDeadline: string;
  idempotencyKey: string;
  createdAt: string;
  cancelledAt: string | null;
};

const listings = new Map<string, MockListing>();
const reservations = new Map<string, MockReservation>();
// (§6 동시성) reserve() idempotency -- a retry with the same key must never
// create a second reservation or double-decrement the seat it already took.
const reservationsByIdempotencyKey = new Map<string, string>();
const purchaseClicksByListing = new Map<string, number>();

export function registerListing(input: Omit<MockListing, "checkCount">): MockListing {
  const listing: MockListing = { ...input, checkCount: 0 };
  listings.set(listing.id, listing);
  return listing;
}

export function getListing(id: string): MockListing | undefined {
  return listings.get(id);
}

export function listAllListings(): MockListing[] {
  return [...listings.values()];
}

function computeSeatsForCheck(scenario: MockBookingScenario, checkCount: number): { standard: number; special: number; definitiveSoldOut: boolean } {
  if (scenario.kind === "always_sold_out") {
    return { standard: 0, special: 0, definitiveSoldOut: true };
  }
  const reached = checkCount >= scenario.checksRequired;
  if (!reached) {
    return { standard: 0, special: 0, definitiveSoldOut: false };
  }
  return {
    standard: scenario.seatClass === "standard" ? 1 : 0,
    special: scenario.seatClass === "special" ? 1 : 0,
    definitiveSoldOut: false,
  };
}

// One GET-status call = one check. This is the only place `checkCount`
// advances, so calling this twice always reports the *next* state -- never
// re-reads the same check.
export function checkSeatStatus(listingId: string): MockSeatStatus {
  const listing = listings.get(listingId);
  if (!listing) {
    throw new Error(`Unknown mock listing: ${listingId}`);
  }
  listing.checkCount += 1;
  const { standard, special, definitiveSoldOut } = computeSeatsForCheck(listing.scenario, listing.checkCount);
  // A seat already consumed by a reservation on this listing is never
  // reported again -- checkRemainingSeats() below subtracts active
  // reservations before returning the caller-visible count.
  const activeReservationCount = [...reservations.values()].filter((r) => r.listingId === listingId && !r.cancelledAt).length;
  const standardRemaining = Math.max(0, standard - activeReservationCount);
  const specialRemaining = Math.max(0, special - activeReservationCount);
  return {
    listingId,
    standardSeats: standardRemaining,
    specialSeats: specialRemaining,
    soldOut: standardRemaining === 0 && specialRemaining === 0,
    definitiveSoldOut,
    checkedAt: new Date().toISOString(),
    checkCount: listing.checkCount,
    purchaseClicked: (purchaseClicksByListing.get(listingId) ?? 0) > 0,
  };
}

export function recordPurchaseClick(listingId: string): { clicked: boolean; clickCount: number } {
  if (!listings.has(listingId)) {
    throw new Error(`Unknown mock listing: ${listingId}`);
  }
  const next = (purchaseClicksByListing.get(listingId) ?? 0) + 1;
  purchaseClicksByListing.set(listingId, next);
  return { clicked: true, clickCount: next };
}

function generateReservationNumber(): string {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `RF-${suffix}`;
}

// (§6 동시성) Idempotent by `idempotencyKey`: a retry with the same key
// returns the exact same reservation record instead of creating a second
// one or re-checking seat availability. This is the mock site's own
// idempotency, independent of (and in addition to) the Worker-level
// stepClaimToken CAS in lib/automation/job-store.ts -- either one alone
// would already prevent a double-booking, and having both is deliberate
// defense-in-depth for a "다시 감시" retry after a Worker crash between the
// reserve() call succeeding and the job store recording it.
export function reserveSeat(input: { listingId: string; seatClass: "standard" | "special"; idempotencyKey: string }): MockReservation {
  const existingId = reservationsByIdempotencyKey.get(input.idempotencyKey);
  if (existingId) {
    const existing = reservations.get(existingId);
    if (existing) return existing;
  }

  const status = checkSeatStatusWithoutAdvancing(input.listingId);
  const available = input.seatClass === "standard" ? status.standardSeats : status.specialSeats;
  if (available <= 0) {
    throw new Error("SOLD_OUT_AT_RESERVE");
  }

  const now = new Date().toISOString();
  const reservation: MockReservation = {
    id: crypto.randomUUID(),
    listingId: input.listingId,
    seatClass: input.seatClass,
    reservationNumber: generateReservationNumber(),
    paymentDeadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    cancelledAt: null,
  };
  reservations.set(reservation.id, reservation);
  reservationsByIdempotencyKey.set(input.idempotencyKey, reservation.id);
  return reservation;
}

// Re-derives the current seat count without incrementing checkCount -- used
// only internally by reserveSeat() so that *placing* a reservation never
// itself counts as an extra "watch tick" check.
function checkSeatStatusWithoutAdvancing(listingId: string): MockSeatStatus {
  const listing = listings.get(listingId);
  if (!listing) {
    throw new Error(`Unknown mock listing: ${listingId}`);
  }
  const { standard, special, definitiveSoldOut } = computeSeatsForCheck(listing.scenario, listing.checkCount);
  const activeReservationCount = [...reservations.values()].filter((r) => r.listingId === listingId && !r.cancelledAt).length;
  return {
    listingId,
    standardSeats: Math.max(0, standard - activeReservationCount),
    specialSeats: Math.max(0, special - activeReservationCount),
    soldOut: false,
    definitiveSoldOut,
    checkedAt: new Date().toISOString(),
    checkCount: listing.checkCount,
    purchaseClicked: (purchaseClicksByListing.get(listingId) ?? 0) > 0,
  };
}

export function getReservation(id: string): MockReservation | undefined {
  return reservations.get(id);
}

export function cancelReservation(id: string): MockReservation | undefined {
  const reservation = reservations.get(id);
  if (!reservation || reservation.cancelledAt) return reservation;
  reservation.cancelledAt = new Date().toISOString();
  return reservation;
}

export function __resetMockBookingSiteForTests(): void {
  listings.clear();
  reservations.clear();
  reservationsByIdempotencyKey.clear();
  purchaseClicksByListing.clear();
}
