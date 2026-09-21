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

// (검토 재반영, §6) 알림 발송은 "Outbox/Claim" 모델이다: (userId,
// idempotencyKey) 조합마다 정확히 한 행만 존재하며, 그 행을 원자적으로
// "claim"(소유권 획득)한 호출자만 실제 Adapter를 호출할 수 있다. 이전의
// "hasDeliveredNotification() 확인 -> Adapter 발송 -> recordNotificationDelivery()
// 저장" 3단계는 두 호출자가 동시에 같은 알림을 처리하면(예: Worker 두 개가
// 겹쳐 실행) 둘 다 1단계를 통과해버릴 수 있는 경쟁 조건이 있었다 -- 발송(비동기
// 대기) *이후*의 저장 단계 충돌은 이미 외부로 알림이 두 번 나간 뒤이므로
// 막을 수 없다. claim은 저장소 쓰기 자체가 소유권 발급이므로 발송 전에
// 원자적으로 단 하나의 호출자만 통과시킨다.
//
// - "pending": (Postgres 등 실제 구현에서) 아직 아무도 claim하지 않은 상태.
//   이 인메모리 구현은 claim 자체가 첫 삽입이라 이 상태를 실제로 만들지는
//   않지만, 상태 공간에는 남겨둔다(먼저 pending으로 삽입한 뒤 별도 UPDATE로
//   claim하는 실제 어댑터 구현도 있을 수 있으므로).
// - "sending": 누군가 claim해 Adapter 호출을 진행 중. `lockExpiresAt`이 지나면
//   다른 호출자가 이 claim을 만료된 것으로 보고 재획득(retry)할 수 있다.
// - "delivered"/"failed": Adapter 호출이 끝난 후의 종료 상태. "failed"는
//   `nextAttemptAt`이 되면 다시 claim할 수 있다(재시도).
// - "skipped_unverified": 소유권이 확인되지 않은 수신처라 Adapter를 아예
//   호출하지 않은 경우 -- claim/lease 개념이 필요 없는 별도 종료 상태.
export type NotificationDeliveryStatus = "pending" | "sending" | "delivered" | "failed" | "skipped_unverified";

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
  // 이 idempotencyKey로 claim을 시도한 횟수(최초 claim 포함). 재시도 추적용.
  attemptCount: number;
  // 가장 최근 실패 사유(있다면). 원문 수신처·비밀값을 절대 포함하지 않는다.
  lastError: string | null;
  // "failed" 상태에서 다시 claim할 수 있게 되는 시각. null이면 즉시 재시도 가능.
  nextAttemptAt: string | null;
  // 현재 claim을 보유 중인 동안의 lease 구간 -- lockExpiresAt이 지나면 다른
  // 호출자가 (Worker가 죽는 등으로 방치된) 이 claim을 재획득할 수 있다.
  lockedAt: string | null;
  lockExpiresAt: string | null;
  // (재검토, fencing token) 현재 claim을 보유한 호출자만 아는 무작위 토큰.
  // status가 "sending"일 때만 의미가 있고(그 claim을 완료할 자격의 증표),
  // 완료(delivered/failed)되거나 애초에 claim된 적이 없으면(skipped_unverified)
  // null이다. 새로 claim하거나 재획득할 때마다 새 값으로 교체된다 -- 아래
  // claimNotification()/completeNotificationClaim() 주석 참고.
  claimToken: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationClaimInput = {
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  deviceId: string;
  watchCycle: number;
  eventType: NotificationEventType;
  idempotencyKey: string;
};

export type NotificationClaimOutcome = "claimed" | "duplicate" | "already_claimed";

// (재검토, fencing token) claim에 성공했을 때만 claimToken이 존재한다 --
// discriminated union으로 강제해, 호출자가 "claimed"가 아닌 결과에서 실수로
// 존재하지 않는 토큰을 완료 처리에 넘기는 실수를 컴파일 타임에 막는다.
export type NotificationClaim =
  | { outcome: "claimed"; entry: NotificationDelivery; claimToken: string }
  | { outcome: "duplicate" | "already_claimed"; entry: NotificationDelivery };

export type CompleteNotificationClaimResult = {
  delivered: boolean;
  deliveryRef: string | null;
  error?: string | null;
};

// (재검토, fencing token) completeNotificationClaim()의 결과. claimToken이
// 현재 저장된 값과 일치하고 상태가 아직 "sending"일 때만 applied:true다.
// 그 외(다른 Worker가 이미 재획득했거나 이미 완료된 경우)는 applied:false와
// 그 이유(reason)를 반환하고, 저장된 행은 절대 건드리지 않는다 -- 뒤늦게
// 도착한 완료가 더 최신 claim의 결과를 덮어쓰는 것을 막는 것이 이 타입의
// 존재 이유다.
export type CompleteNotificationClaimOutcome =
  | { applied: true; entry: NotificationDelivery }
  | { applied: false; reason: "stale_claim" | "not_claimed"; entry: NotificationDelivery | null };

export type ConsentType = "no_ticket_sale_disclaimer" | "notification_permission";

export type ConsentHistoryEntry = {
  id: string;
  userId: string;
  consentType: ConsentType;
  granted: boolean;
  at: string;
};

// AuditAction/AuditEvent moved to lib/audit/types.ts (재검토, §3): both
// lib/auth and lib/watch record into the same audit trail now, so the
// type/storage boundary can't live inside this module any more -- see
// lib/audit/types.ts's doc comment for why.

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
