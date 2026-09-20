import "server-only";

// The v0.5 "취소표 감시(Seat Watch)" domain. RailFlow never books or pays for
// a seat here -- it only watches and notifies. A human always completes the
// real reservation in 코레일+/공식 예매. See docs/V0.5-SEAT-WATCH.md.
//
// `User` itself is not redefined here: it lives in lib/auth/types.ts
// (AuthUser). Every entity below carries a `userId` foreign key into that
// table -- see db/postgres/migrations for the schema that makes this a real
// FK once a persistent store exists.

export type JobStatus =
  | "REGISTERED"
  | "WATCHING"
  | "SEAT_FOUND"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "FAILED";

export type SeatClassPreference = "standard_only" | "standard_preferred" | "any";

export type NotificationChannel = "fcm" | "webpush" | "telegram" | "email";

export type WatchErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "DUPLICATE_JOB"
  | "INVALID_TRANSITION"
  | "JOBS_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "SIMULATION_NOT_ALLOWED"
  | "CHECK_FAILED"
  | "NOTIFICATION_NOT_CONFIGURED"
  | "INVALID_DEVICE";

export class WatchError extends Error {
  constructor(
    readonly code: WatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WatchError";
  }
}

// A device/destination the user registered to receive notifications on.
// `token` is whatever the channel needs (FCM registration token, WebPush
// subscription JSON, Telegram chat id, or an email address) -- opaque to
// this module.
export type Device = {
  id: string;
  userId: string;
  channel: NotificationChannel;
  token: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
};

// A single train the user is willing to accept, taken from a v0.3/TAGO
// schedule search result. `mockScenario` is only ever read by the mock Seat
// Availability Provider (dev/test) -- never by any real provider.
export type TrainCandidate = {
  id: string;
  trainNumber: string;
  trainType: string;
  departAt: string;
  arriveAt: string;
  mockScenario?: "seat_after_one_check" | "no_seat_ever" | "error_on_check";
};

export type WatchJobHistoryEntry = {
  at: string;
  from: JobStatus | null;
  to: JobStatus;
  reason: string;
};

export type WatchJobInput = {
  userId: string;
  departure: string;
  arrival: string;
  departureId: string;
  arrivalId: string;
  date: string;
  timeRangeStart: string;
  timeRangeEnd: string;
  trainType: string;
  passengers: number;
  seatClassPreference: SeatClassPreference;
  candidates: TrainCandidate[];
  watchUntil: string;
  notificationMethods: Array<{ channel: NotificationChannel; deviceId: string }>;
};

export type WatchJob = WatchJobInput & {
  id: string;
  status: JobStatus;
  seatProvider: "unavailable" | "mock";
  // True whenever seatProvider is "mock". Carried on the job itself (not
  // just on provider results) so the API/UI contract can never present a
  // watch job as backed by a real seat feed -- same reasoning as v0.4's
  // ReservationJob.simulation field.
  simulation: boolean;
  foundCandidateId: string | null;
  foundAt: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError: { code: WatchErrorCode; message: string } | null;
  history: WatchJobHistoryEntry[];
};

export type NotificationEventType =
  | "seat_found"
  | "watch_started"
  | "watch_expired"
  | "auth_required"
  | "provider_unavailable"
  | "duplicate_job_blocked"
  | "system_halted"
  | "booking_confirmation_requested";

export type NotificationDelivery = {
  id: string;
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  eventType: NotificationEventType;
  idempotencyKey: string;
  status: "delivered" | "failed" | "skipped_duplicate";
  deliveryRef: string | null;
  createdAt: string;
};

export type ConsentType = "no_ticket_sale_disclaimer" | "notification_permission";

export type ConsentHistoryEntry = {
  id: string;
  userId: string;
  consentType: ConsentType;
  granted: boolean;
  at: string;
};

export type AuditAction =
  | "user_signup"
  | "user_login"
  | "user_logout"
  | "user_deleted"
  | "watch_job_created"
  | "watch_job_cancelled"
  | "watch_job_completed"
  | "device_registered";

export type AuditEvent = {
  id: string;
  userId: string;
  action: AuditAction;
  targetId: string | null;
  at: string;
  // Never put secrets, tokens, or raw notification destinations in here --
  // see lib/watch/store.ts's recordAuditEvent and scripts/verify-seat-watch.cjs's
  // secret-leak assertion.
  metadata: Record<string, string> | null;
};

// -- Provider/Adapter interfaces --------------------------------------------

export type ProviderCapabilities = {
  supportsAvailabilityCheck: boolean;
  simulation: boolean;
};

export type SeatCheckResult = {
  candidateId: string;
  // null means "we do not know" (no real provider connected) -- this is the
  // PROVIDER_UNAVAILABLE contract from §1: never claim a real seat check
  // happened when it did not.
  available: boolean | null;
  providerStatus: "unavailable" | "ok" | "error";
  checkedAt: string;
  simulation: boolean;
};

// Never contacts TAGO, KORAIL, SR, or any real railway endpoint. A real
// implementation of this interface (once an official Provider is
// contracted) is the only thing that may ever set `available` to a real
// boolean -- see docs/adr/0002.
export interface SeatAvailabilityProvider {
  readonly name: "unavailable" | "mock";
  capabilities(): ProviderCapabilities;
  checkSeats(job: WatchJob): Promise<SeatCheckResult[]>;
}

export type BookingLaunchResult = {
  // Always false in this PR: no officially-confirmed 코레일+ deep link
  // scheme exists, so this module never fabricates one (§F).
  deepLinkAvailable: boolean;
  appDeepLink: string | null;
  webFallbackUrl: string;
  // Human-readable trip condition text the UI offers as a one-tap copy, so
  // the user can paste it into 코레일+'s own search fields.
  copyText: string;
};

export interface BookingLaunchProvider {
  readonly name: string;
  launch(job: WatchJob, candidateId: string): Promise<BookingLaunchResult>;
}

export type NotificationPayload = {
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  eventType: NotificationEventType;
  idempotencyKey: string;
  destination: string;
  title: string;
  body: string;
};

export type NotificationSendResult = {
  delivered: boolean;
  deliveryRef: string | null;
};

export interface NotificationAdapter {
  readonly channel: NotificationChannel;
  send(payload: NotificationPayload): Promise<NotificationSendResult>;
}
