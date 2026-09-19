import "server-only";

export type JobStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "WATCHING"
  | "RESERVING"
  | "HELD"
  | "PAYMENT_PENDING"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "PROVIDER_CHANGED"
  | "FAILED";

export type SeatClassPreference = "standard_only" | "standard_preferred" | "any";

export type ReservationErrorCode =
  | "NOT_CONFIGURED"
  | "OFFICIAL_INTEGRATION_REQUIRED"
  | "INVALID_TRANSITION"
  | "SIMULATION_INTERVAL_NOT_ALLOWED"
  | "PROVIDER_MISMATCH"
  | "JOBS_DISABLED"
  | "DUPLICATE_JOB"
  | "NOT_FOUND"
  | "CHECK_FAILED"
  | "RESERVE_FAILED";

export class ReservationProviderError extends Error {
  constructor(
    readonly code: ReservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReservationProviderError";
  }
}

// A candidate train the user is willing to accept, taken from a v0.3 schedule
// search result (see lib/rail/types.ts TrainResult). Never contains pricing
// beyond what TAGO already reports; RailFlow does not compute or guarantee fares.
export type TrainCandidate = {
  id: string;
  trainNumber: string;
  departAt: string;
  arriveAt: string;
  // Optional: only meaningful for the mock provider's test scenarios (§ simulation-guard).
  // Never read by OfficialReservationProviderStub.
  mockScenario?: "seat_after_one_check" | "no_seat_ever" | "error_on_check" | "error_on_reserve";
};

export type ReservationJobInput = {
  userId: string;
  departure: string;
  arrival: string;
  departureId: string;
  arrivalId: string;
  date: string;
  timeRangeStart: string;
  timeRangeEnd: string;
  passengers: number;
  seatClassPreference: SeatClassPreference;
  candidates: TrainCandidate[];
  expiresAt: string;
};

export type ReservationJobHistoryEntry = {
  at: string;
  from: JobStatus | null;
  to: JobStatus;
  reason: string;
};

export type ReservationJob = ReservationJobInput & {
  id: string;
  status: JobStatus;
  provider: "mock" | "official";
  // True for every job this PR can create (only "mock" jobs are ever created --
  // see job-store.createJob and the API-boundary block on "official"). Carried
  // on the job itself, not just on individual provider results, so the API
  // envelope and the UI can never present a job as a real reservation.
  simulation: boolean;
  createdAt: string;
  updatedAt: string;
  heldCandidateId: string | null;
  // Seat-hold payment deadline from the provider's ReservationResult, distinct
  // from `expiresAt` (the watch/search deadline). This PR does not auto-expire
  // PAYMENT_PENDING jobs against it -- see docs/V0.4-ARCHITECTURE.md.
  holdExpiresAt: string | null;
  attempts: number;
  lastError: { code: ReservationErrorCode; message: string } | null;
  history: ReservationJobHistoryEntry[];
};

export type ProviderCapabilities = {
  supportsAvailability: boolean;
  supportsHold: boolean;
  supportsPayment: boolean;
  supportsCancellation: boolean;
  simulation: boolean;
};

// Every result a RailReservationProvider returns carries `simulation` so no
// caller can mistake a mock outcome for a real reserved seat. The mock
// provider always sets it true; the official stub never returns a result at
// all (it always throws OFFICIAL_INTEGRATION_REQUIRED).
export type AvailabilityResult = {
  candidateId: string;
  available: boolean;
  checkedAt: string;
  simulation: boolean;
};

export type ReservationResult = {
  held: boolean;
  candidateId: string;
  holdExpiresAt: string | null;
  simulation: boolean;
};

export type ReservationStatus = {
  status: JobStatus;
  heldCandidateId: string | null;
  simulation: boolean;
};

export type CancelResult = {
  cancelled: boolean;
  simulation: boolean;
};

// Reservation providers never call TAGO and never see DATA_GO_KR_SERVICE_KEY --
// they operate purely on the candidates a RailScheduleProvider search already
// returned. Splitting these interfaces keeps "look up a timetable" and "act on
// a real seat" as two capabilities that can be enabled independently and
// defaulted to off (see lib/reservation/feature-flags.ts).
export interface RailReservationProvider {
  readonly name: "mock" | "official";
  capabilities(): ProviderCapabilities;
  checkAvailability(job: ReservationJob): Promise<AvailabilityResult>;
  reserve(job: ReservationJob, candidateId: string): Promise<ReservationResult>;
  getReservation(job: ReservationJob): Promise<ReservationStatus>;
  cancel(job: ReservationJob): Promise<CancelResult>;
}
