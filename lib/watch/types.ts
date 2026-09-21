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
  | "INVALID_DEVICE"
  // §1 검토사항: WATCH_STORE가 usable 상태가 아닐 때 -- lib/watch/feature-flags.ts.
  | "WATCH_STORE_DISABLED"
  // §5 검토사항: notificationMethods[].channel이 등록된 Device.channel과 다를 때.
  | "NOTIFICATION_CHANNEL_MISMATCH"
  // §7 검토사항: 후보 열차 중복/날짜 불일치/시간범위 밖/도착이 출발보다 빠름 등.
  | "INVALID_CANDIDATE";

export class WatchError extends Error {
  constructor(
    readonly code: WatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WatchError";
  }
}

// 알림 수신처(Device) 하나. `token`은 채널마다 다른 의미를 가지는 불투명한
// 값(FCM 등록 토큰, WebPush 구독 JSON, 텔레그램 chat id, 이메일 주소)이며
// 이 모듈은 그 내용을 해석하지 않는다.
//
// `verified`: 소유권이 실제로 확인됐는지 여부. fcm/webpush는 브라우저/OS가
// 발급한 값이라 등록 즉시 true로 취급하지만, email/telegram은 어떤
// 사용자든 다른 사람의 주소나 chat id를 자유롭게 입력할 수 있으므로 소유권
// 확인 절차(이번 PR에는 없음)가 끝나기 전까지 항상 false다. verified가
// false인 동안은 실제 알림을 절대 보내지 않는다 -- lib/watch/notification/dispatch.ts.
export type Device = {
  id: string;
  userId: string;
  channel: NotificationChannel;
  token: string;
  verified: boolean;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
};

// API/UI에 내려주는 안전한 표현. 원문 token은 절대 포함하지 않는다(§5 검토사항).
export type DeviceSummary = {
  id: string;
  channel: NotificationChannel;
  maskedDestination: string;
  verified: boolean;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
};

// 저장된 후보 열차. `id`는 서버가 생성하는 UUID(db/postgres의
// watch_job_candidates.id와 타입을 맞춤)이며 클라이언트가 지정할 수 없다.
// `externalKey`는 v0.3/TAGO 시간표 검색 결과 등 출처 쪽 식별자를 그대로
// 담는 클라이언트 제공 문자열로, 같은 WatchJob 안에서 중복될 수 없다(§7).
export type TrainCandidate = {
  id: string;
  externalKey: string;
  trainNumber: string;
  trainType: string;
  departAt: string;
  arriveAt: string;
  mockScenario?: "seat_after_one_check" | "no_seat_ever" | "error_on_check";
};

// 클라이언트가 보내는 입력 형태 -- id가 없다(서버가 생성하므로).
export type TrainCandidateInput = Omit<TrainCandidate, "id">;

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
  candidates: TrainCandidateInput[];
  watchUntil: string;
  notificationMethods: Array<{ channel: NotificationChannel; deviceId: string }>;
};

export type WatchJob = Omit<WatchJobInput, "candidates"> & {
  id: string;
  candidates: TrainCandidate[];
  status: JobStatus;
  seatProvider: "unavailable" | "mock";
  // True whenever seatProvider is "mock". Carried on the job itself (not
  // just on provider results) so the API/UI contract can never present a
  // watch job as backed by a real seat feed -- same reasoning as v0.4's
  // ReservationJob.simulation field.
  simulation: boolean;
  // "다시 감시"를 누를 때마다 서버가 1씩 증가시키는 세대 카운터(§6). 알림
  // 멱등키에 포함돼, 재감시 이후 같은 후보가 다시 발견되면 새 알림을 보낼 수
  // 있게 하면서도 같은 세대 안의 중복은 여전히 막는다.
  watchCycle: number;
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

export type NotificationDeliveryStatus = "delivered" | "failed" | "skipped_duplicate" | "skipped_unverified";

export type NotificationDelivery = {
  id: string;
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  // §6 검토사항: 멱등키에 channel+deviceId+watchCycle을 포함시킨 것과 별개로,
  // 감사·디버깅을 위해 배달 기록 자체에도 어느 기기·몇 번째 감시 세대였는지
  // 남긴다.
  deviceId: string;
  watchCycle: number;
  eventType: NotificationEventType;
  idempotencyKey: string;
  status: NotificationDeliveryStatus;
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
