import "server-only";

// v0.9 "서버형 취소표 감시 -> 좌석 확보 -> 사용자 직접 결제" 도메인.
//
// 이 모듈은 lib/reservation/**(v0.4), lib/watch/**(v0.5),
// lib/automation/**(v0.7)과 완전히 독립적이다. 그들의 *패턴*(claim +
// fencing token, 멱등키, Outbox, fail-closed 플래그)은 재사용하되 import
// 하지 않는다 -- 그래야 이 PR이 기존 상태 기계를 망가뜨릴 수 없다.
//
// 핵심 원칙
//  - RailFlow는 **결제하지 않는다.** 좌석을 확보(hold)한 뒤 사용자가 공식
//    앱에서 직접 결제한다.
//  - 실제 Provider는 **공개·승인된 연동 경로가 확인된 경우에만** 동작한다.
//    확인 전에는 unavailable 이 기본값이고, 화면은 "공식 연동 준비 중"을
//    정직하게 표시한다.
//  - 브라우저 자동화로 공식 화면을 조작하지 않는다
//    (docs/V0.8-LIVE-AUTOMATION-POSTMORTEM.md).

/**
 * 작업 상태.
 *
 * `RESERVATION_CLAIMING` 과 `AMBIGUOUS_RESULT` 가 이 설계의 핵심이다:
 * 예약 요청의 응답이 불명확할 때 절대 재예약하지 않고, 예약내역 재조회로
 * 결과를 확정하며, 확정할 수 없으면 사람에게 넘긴다.
 */
export type AutobookJobStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "WATCHING"
  | "SEAT_FOUND"
  | "RESERVATION_CLAIMING"
  | "RESERVATION_HELD"
  | "PAYMENT_PENDING"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "AMBIGUOUS_RESULT"
  | "BLOCKED_BY_OPERATOR";

export const AUTOBOOK_JOB_STATUSES: readonly AutobookJobStatus[] = [
  "DRAFT",
  "SCHEDULED",
  "WATCHING",
  "SEAT_FOUND",
  "RESERVATION_CLAIMING",
  "RESERVATION_HELD",
  "PAYMENT_PENDING",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "AMBIGUOUS_RESULT",
  "BLOCKED_BY_OPERATOR",
];

/** 더 이상 Worker가 진행하지 않는 상태. */
export const TERMINAL_STATUSES: readonly AutobookJobStatus[] = [
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "AMBIGUOUS_RESULT",
  "BLOCKED_BY_OPERATOR",
];

/** 사람이 직접 확인해야 풀리는 상태. UI에서 눈에 띄게 표시한다. */
export const USER_ACTION_STATUSES: readonly AutobookJobStatus[] = [
  "RESERVATION_HELD",
  "PAYMENT_PENDING",
  "AUTH_REQUIRED",
  "AMBIGUOUS_RESULT",
];

export type SeatClassPreference = "standard_only" | "first_only" | "any";

export type AutobookErrorCode =
  | "JOBS_DISABLED"
  | "STORE_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "OFFICIAL_INTEGRATION_REQUIRED"
  | "ACCOUNT_LINK_REQUIRED"
  | "INVALID_TRANSITION"
  | "DUPLICATE_JOB"
  | "NOT_FOUND"
  | "STALE_CLAIM"
  | "RATE_LIMITED"
  | "BLOCKED_BY_OPERATOR"
  | "AMBIGUOUS_RESULT"
  | "INVALID_INPUT"
  | "KILL_SWITCH_ON";

export class AutobookError extends Error {
  constructor(
    readonly code: AutobookErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AutobookError";
  }
}

/** 감시 대상 열차 한 편. TAGO 시간표에서 온 값만 담는다(가상 열차를 만들지 않는다). */
export type AutobookCandidate = {
  id: string;
  trainNumber: string;
  trainType: string;
  departAt: string;
  arriveAt: string;
  /** 후보별 진행 상태. 하나가 확정되면 나머지는 STOPPED 가 된다. */
  state: "PENDING" | "WATCHING" | "SEAT_FOUND" | "RESERVED" | "STOPPED";
  lastCheckedAt: string | null;
  checkCount: number;
};

export type AutobookCondition = {
  departure: string;
  arrival: string;
  date: string;
  passengers: number;
  seatClass: SeatClassPreference;
  /** 감시 시간대. 비우면 날짜 전체. */
  timeFrom: string | null;
  timeTo: string | null;
};

export type AutobookJob = {
  id: string;
  userId: string;
  status: AutobookJobStatus;
  condition: AutobookCondition;
  candidates: AutobookCandidate[];
  /** 어느 Provider가 이 작업을 처리하는지. 화면이 실제/Mock을 구분하는 근거. */
  providerName: string;
  /** Mock Provider로 만들어진 작업인지. 화면에서 절대 실제처럼 보이면 안 된다. */
  simulation: boolean;
  /** 같은 사용자·날짜·구간·인원에 활성 작업 하나만 허용하기 위한 키. */
  dedupeKey: string;
  /** 예약 요청의 멱등키. 재시도해도 예약이 두 번 생기지 않게 한다. */
  reservationIdempotencyKey: string;
  /** 좌석 확보 결과. 확정된 것만 들어간다. */
  hold: AutobookHold | null;
  /** 마지막 실패·중단 사유(사용자에게 보여줄 수 있는 문구). */
  statusDetail: string | null;
  attempts: number;
  /** 다음 조회 예정 시각. rate limit·백오프가 이 값을 민다. */
  nextCheckAt: string | null;
  /** 작업 자체의 만료. 출발 시각이 지나면 EXPIRED. */
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** 현재 이 작업을 잡고 있는 Worker. 없으면 null. */
  claim: AutobookClaim | null;
};

export type AutobookClaim = {
  workerId: string;
  /** 단조 증가. 되돌릴 수 없는 동작 직전에 최신인지 확인한다. */
  fencingToken: number;
  claimedAt: string;
  /** 이 시각이 지나면 죽은 claim 으로 보고 다른 Worker가 가져갈 수 있다. */
  leaseExpiresAt: string;
};

export type AutobookHold = {
  candidateId: string;
  trainNumber: string;
  departAt: string;
  /** 공식 화면에서 확인된 예약 식별자. 로그·응답에서는 마스킹된다. */
  reservationRef: string;
  /** 실제 결제기한. 화면에서 확인하지 못하면 null 이며 추정값을 만들지 않는다. */
  paymentDueAt: string | null;
  /** 사용자가 결제하러 갈 공식 경로(딥링크 또는 안내). */
  officialPaymentUrl: string | null;
  confirmedBy: "reservationList" | "createResponse";
  confirmedAt: string;
};

// --- Provider 계약 ---------------------------------------------------------

export type SeatAvailability =
  | { kind: "AVAILABLE"; candidateId: string; seatClass: "standard" | "first"; observedAt: string }
  | { kind: "SOLD_OUT"; observedAt: string }
  | { kind: "UNKNOWN"; observedAt: string; reason: string };

/**
 * 예약 생성 결과.
 *
 * `AMBIGUOUS` 가 있는 이유: 요청은 나갔는데 응답을 받지 못한 경우가 실재한다.
 * 그때 "실패"로 처리하고 재시도하면 중복 예약이 생긴다. 반드시 별도 상태로
 * 받아서 예약내역 재조회로 확정해야 한다.
 */
export type ReservationAttempt =
  | { kind: "HELD"; hold: AutobookHold }
  | { kind: "GONE"; observedAt: string }
  | { kind: "AMBIGUOUS"; observedAt: string; reason: string }
  | { kind: "AUTH_REQUIRED"; observedAt: string }
  | { kind: "RATE_LIMITED"; observedAt: string; retryAfterSeconds: number }
  | { kind: "BLOCKED_BY_OPERATOR"; observedAt: string; reason: string };

export type ProviderCapabilities = {
  /** 좌석 상태를 읽을 수 있는가. */
  canReadAvailability: boolean;
  /** 예약을 생성할 수 있는가. */
  canCreateReservation: boolean;
  /** 예약내역을 재조회해 결과를 확정할 수 있는가. 이것이 없으면 예약을 시도하면 안 된다. */
  canVerifyReservation: boolean;
  /** 시뮬레이션인가. 실제 Provider는 반드시 false. */
  simulation: boolean;
};

export interface SeatReservationProvider {
  /** `unavailable` | `mock-server` | `official-approved` 등. UI가 그대로 표시한다. */
  readonly name: string;
  capabilities(): ProviderCapabilities;
  /** 좌석 상태 조회. */
  checkAvailability(input: {
    job: AutobookJob;
    candidate: AutobookCandidate;
  }): Promise<SeatAvailability>;
  /**
   * 예약 생성. 멱등키를 반드시 전달받는다 -- 같은 키로 두 번 호출해도
   * 예약이 하나만 생겨야 한다.
   */
  createReservation(input: {
    job: AutobookJob;
    candidate: AutobookCandidate;
    idempotencyKey: string;
  }): Promise<ReservationAttempt>;
  /**
   * 예약내역 재조회. "요청을 보냈다"와 "예약이 생겼다"를 분리하는 장치다.
   * 확정할 수 없으면 null 을 돌려준다(그 경우 AMBIGUOUS_RESULT 로 멈춘다).
   */
  findExistingReservation(input: {
    job: AutobookJob;
    idempotencyKey: string;
  }): Promise<AutobookHold | null>;
}

// --- 알림 Outbox ------------------------------------------------------------

export type AutobookNotificationKind =
  | "SEAT_HELD"
  | "PAYMENT_DUE_SOON"
  | "EXPIRED"
  | "AUTH_REQUIRED"
  | "AMBIGUOUS_RESULT";

export type AutobookNotification = {
  id: string;
  jobId: string;
  userId: string;
  kind: AutobookNotificationKind;
  /** 같은 사건에 대해 한 번만 보내기 위한 키. */
  idempotencyKey: string;
  payload: Record<string, string | number | null>;
  createdAt: string;
  claimedBy: string | null;
  claimedFencingToken: number | null;
  sentAt: string | null;
  failedAttempts: number;
};

// --- 계정 연결 --------------------------------------------------------------

/**
 * 계정 연결 상태.
 *
 * 중요: RailFlow는 이번 단계에서 **실제 코레일 계정 비밀번호를 저장하지
 * 않는다.** 공식 OAuth·파트너 토큰이 확인되기 전까지 실제 자격증명 입력은
 * 비활성화되어 있고, 이 타입은 "무엇이 없어서 못 하는지"를 표현한다.
 */
export type AccountLinkStatus =
  | { kind: "NOT_LINKED"; reason: "OFFICIAL_METHOD_UNAVAILABLE" }
  | { kind: "NOT_LINKED"; reason: "USER_NOT_LINKED" }
  | { kind: "LINKED"; method: "official_oauth" | "official_api_credential" | "short_lived_session"; linkedAt: string; expiresAt: string | null }
  | { kind: "EXPIRED"; method: string; expiredAt: string };
