import "server-only";

// v0.7 "자동 좌석조회·예약 매크로 시뮬레이터" domain. This is a NEW module,
// independent of lib/reservation/** and lib/watch/** -- it reuses their
// *patterns* (job/store/queue/worker split, claim+fencing-token CAS,
// idempotency keys, feature-flag fail-closed gates) but never imports from
// them, so this PR cannot regress v0.4's ReservationJob or v0.5's WatchJob
// state machines. See docs/V0.7-BOOKING-MACRO-SIMULATOR.md.
//
// RailFlow never automates a real railway site here. Every "seat" and every
// "reservation" this module can ever produce comes from RailFlow's own Mock
// booking site (lib/automation/mock-booking-site/**, app/demo/booking-
// simulator) -- see docs/V0.7-AUTOMATION-BOUNDARY.md for the host allowlist
// that makes this a code-level guarantee, not a policy promise.

export type JobStatus =
  | "SCHEDULED"
  | "WATCHING"
  | "CHECKING_AVAILABILITY"
  | "SEAT_FOUND"
  | "PURCHASE_CLICKING"
  | "RESERVING"
  | "HELD"
  | "PAYMENT_PENDING"
  | "SOLD_OUT"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "PROVIDER_CHANGED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "PAYMENT_EXPIRED"
  | "COMPLETED";

export type SeatClassPreference = "standard_only" | "standard_preferred" | "any";

export type AutomationErrorCode =
  | "NOT_CONFIGURED"
  | "OFFICIAL_INTEGRATION_REQUIRED"
  | "AUTOMATION_TARGET_NOT_ALLOWED"
  | "RUNTIME_NOT_SUPPORTED"
  | "INVALID_TRANSITION"
  | "JOBS_DISABLED"
  | "DUPLICATE_JOB"
  | "NOT_FOUND"
  | "STALE_CLAIM"
  | "CHECK_FAILED"
  | "PURCHASE_CLICK_FAILED"
  | "RESERVE_FAILED"
  | "SIMULATION_INTERVAL_NOT_ALLOWED"
  | "INVALID_CANDIDATE";

export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

// Mock booking-site scenario a candidate listing is wired to (§3-A). Never
// read by the official Provider stub. `checksRequired` counts GET-status
// calls against lib/automation/mock-booking-site/store.ts, not real time.
export type MockBookingScenario =
  | { kind: "always_sold_out" }
  | { kind: "seat_after_n_checks"; checksRequired: number; seatClass: "standard" | "special" };

// `id` must reference an existing lib/automation/mock-booking-site listing
// (the three seeded in dev/test -- see mock-booking-site/seed.ts). Unlike
// v0.4/v0.5's mockScenario-on-the-candidate pattern, this PR's scenario
// (always sold out / seat on the Nth check / etc.) lives server-side on the
// Mock booking site's own listing record, not on the job -- the
// mock-browser Provider discovers it by actually loading that listing's
// page, exactly like a real automation would, rather than being told the
// answer in advance.
export type AutomationCandidate = {
  id: string;
  trainNumber: string;
  trainType: string;
  departAt: string;
  arriveAt: string;
  fareLabel: string;
};

export type AutomationJobInput = {
  userId: string;
  departure: string;
  arrival: string;
  date: string;
  timeRangeStart: string;
  timeRangeEnd: string;
  passengers: number;
  seatClassPreference: SeatClassPreference;
  candidates: AutomationCandidate[];
  watchUntil: string;
  intervalSeconds: number;
};

export type AutomationJobHistoryEntry = {
  at: string;
  from: JobStatus | null;
  to: JobStatus;
  reason: string;
};

export type AutomationJob = AutomationJobInput & {
  id: string;
  status: JobStatus;
  provider: "mock-browser" | "mock-direct" | "unavailable" | "official";
  // True for every job this PR can ever create (only "mock-browser" jobs are
  // ever created -- the API boundary blocks "official" exactly like v0.4's
  // ReservationJob does). Carried on the job itself so the API/UI contract
  // can never present a job as a real automation run.
  simulation: boolean;
  watchCycle: number;
  attempts: number;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  seatFoundAt: string | null;
  purchaseClickedAt: string | null;
  reservedAt: string | null;
  heldCandidateId: string | null;
  reservationNumber: string | null;
  paymentDeadline: string | null;
  // Candidate ids the mock site has reported as *definitively* sold out
  // (never reopening) at least once. Once this covers every selected
  // candidate, the Worker retires the whole job to SOLD_OUT instead of
  // watching forever -- see lib/automation/worker.ts.
  definitiveSoldOutCandidateIds: string[];
  // (§6 동시성) fencing token for the SEAT_FOUND -> PURCHASE_CLICKING ->
  // RESERVING critical section -- see lib/automation/job-store.ts's
  // claimJobStep()/completeJobStep(), which mirror lib/watch/store.ts's
  // notification claim/complete CAS exactly. null whenever no step is
  // currently claimed.
  stepClaimToken: string | null;
  stepLockExpiresAt: string | null;
  // Idempotency for reserve(): sequence number for the last successfully
  // completed reservation *inside this job's lifetime* (a "다시 감시" bumps
  // watchCycle, allowing a fresh reservation attempt for the new cycle
  // without ever re-using an already-consumed idempotency key).
  reservedForCycle: number | null;
  // §6: "알림도 한 watch cycle당 한 번만 전송된다" -- null until a success
  // notification has actually been dispatched for `watchCycle`.
  notifiedForCycle: number | null;
  lastError: { code: AutomationErrorCode; message: string } | null;
  history: AutomationJobHistoryEntry[];
  createdAt: string;
  updatedAt: string;
};

// -- Provider interface (§3-D) ----------------------------------------------

export type AvailabilityInput = {
  job: AutomationJob;
  candidate: AutomationCandidate;
};

export type AvailabilityResult = {
  candidateId: string;
  available: boolean;
  seatClass: "standard" | "special" | null;
  // true only when the mock site itself reports the listing as permanently
  // sold out (no cancellation will ever reopen it) -- distinct from an
  // ordinary "no seats on this check" retryable miss. Drives job-level
  // SOLD_OUT (all candidates definitive) vs. staying in WATCHING.
  definitiveSoldOut: boolean;
  checkedAt: string;
  simulation: boolean;
};

export type PurchaseInput = {
  job: AutomationJob;
  candidateId: string;
};

export type PurchaseClickResult = {
  clicked: boolean;
  clickedAt: string;
  simulation: boolean;
};

export type ReservationInput = {
  job: AutomationJob;
  candidateId: string;
  idempotencyKey: string;
};

export type ReservationResult = {
  reserved: boolean;
  candidateId: string;
  reservationNumber: string;
  paymentDeadline: string;
  simulation: boolean;
};

export type ReservationStatusInput = {
  job: AutomationJob;
};

export type ReservationStatus = {
  status: JobStatus;
  reservationNumber: string | null;
  simulation: boolean;
};

export type CancelReservationInput = {
  job: AutomationJob;
};

export type CancelResult = {
  cancelled: boolean;
  simulation: boolean;
};

export type AutomationProviderCapabilities = {
  supportsAvailability: boolean;
  supportsPurchaseClick: boolean;
  supportsReservation: boolean;
  supportsCancellation: boolean;
  simulation: boolean;
};

// RailFlow never has an "official" implementation of this interface in this
// PR -- see lib/automation/providers/official-stub-provider.ts, which always
// throws OFFICIAL_INTEGRATION_REQUIRED and never calls fetch/Playwright.
export interface SeatAutomationProvider {
  readonly name: "mock-browser" | "mock-direct" | "unavailable" | "official";
  capabilities(): AutomationProviderCapabilities;
  searchAvailability(input: AvailabilityInput): Promise<AvailabilityResult>;
  clickPurchase(input: PurchaseInput): Promise<PurchaseClickResult>;
  reserve(input: ReservationInput): Promise<ReservationResult>;
  getReservation(input: ReservationStatusInput): Promise<ReservationStatus>;
  cancelReservation(input: CancelReservationInput): Promise<CancelResult>;
}
