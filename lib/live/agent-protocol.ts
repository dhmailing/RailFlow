// RailFlow 웹 UI가 로컬 Agent와 주고받는 값의 타입.
//
// 이 파일은 agent/src/status.mjs 의 거울이다. 두 파일이 어긋나면
// tests/agent/protocol-parity.test.mjs 가 실패한다.
//
// 여기 있는 상태는 전부 "실제 공식 화면에서 읽은 것"이다. 시뮬레이터
// (lib/automation-demo/**, lib/demo/**)의 상태와 절대 섞어 쓰지 않는다.

/**
 * 로컬 Agent가 띄우는 화면 주소.
 *
 * 공개 배포본(https)이 이 주소를 직접 호출하지는 않는다 -- 브라우저가
 * 막는다(docs/V0.8-LOCAL-CONNECTION.md). 사용자에게 안내하는 용도다.
 */
export const LOCAL_CONSOLE_URL = "http://127.0.0.1:4319/";

export const SEAT_STATUSES = [
  "AVAILABLE_STANDARD",
  "AVAILABLE_FIRST",
  "AVAILABLE_ANY",
  "SOLD_OUT",
  "WAITLIST_AVAILABLE",
  "AUTH_REQUIRED",
  "ADDITIONAL_VERIFICATION_REQUIRED",
  "QUEUE_OR_ACCESS_RESTRICTED",
  "PROVIDER_CHANGED",
  "UNKNOWN",
] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

export const JOB_STATES = [
  "IDLE",
  "LAUNCHING_BROWSER",
  "WAITING_MANUAL_LOGIN",
  "CONNECTED",
  "SEARCHING_TRAIN",
  "TRAIN_CONFIRMED",
  "WATCHING_SOLD_OUT",
  "SEAT_FOUND",
  "AWAITING_ARM_CONFIRMATION",
  "RESERVING",
  "VERIFYING_RESERVATION",
  "RESERVED_PAYMENT_REQUIRED",
  "AUTH_REQUIRED",
  "ADDITIONAL_VERIFICATION_REQUIRED",
  "QUEUE_OR_ACCESS_RESTRICTED",
  "PROVIDER_CHANGED",
  "RESULT_UNCERTAIN_USER_CHECK_REQUIRED",
  "RECONCILIATION_REQUIRED",
  "STOPPED_BY_USER",
  "FAILED",
] as const;
export type LiveJobState = (typeof JOB_STATES)[number];

export type LiveRunMode = "LIVE_READ_ONLY" | "LIVE_RESERVATION_ARMED";

export type SeatPreference = "standard_only" | "first_only" | "any";

/** 화면에 보여줄 한국어 라벨. 실제 상태와 시연 상태를 문구로도 구분한다. */
export const JOB_STATE_LABEL: Record<LiveJobState, string> = {
  IDLE: "대기",
  LAUNCHING_BROWSER: "브라우저 실행 중",
  WAITING_MANUAL_LOGIN: "로그인 대기",
  CONNECTED: "실제 사이트 연결됨",
  SEARCHING_TRAIN: "열차 확인 중",
  TRAIN_CONFIRMED: "열차 확인됨",
  WATCHING_SOLD_OUT: "좌석 없음 · 감시 중",
  SEAT_FOUND: "좌석 발견",
  AWAITING_ARM_CONFIRMATION: "예약 승인 대기",
  RESERVING: "예약 요청 중",
  VERIFYING_RESERVATION: "예약 결과 확인 중",
  RESERVED_PAYMENT_REQUIRED: "예약 성공 · 결제 필요",
  AUTH_REQUIRED: "로그인 필요",
  ADDITIONAL_VERIFICATION_REQUIRED: "추가 인증 필요",
  QUEUE_OR_ACCESS_RESTRICTED: "접근 제한으로 중단",
  PROVIDER_CHANGED: "화면 변경으로 중단",
  RESULT_UNCERTAIN_USER_CHECK_REQUIRED: "결과 불명확 · 사용자 확인 필요",
  RECONCILIATION_REQUIRED: "기존 예약 확인 필요",
  STOPPED_BY_USER: "사용자 중단",
  FAILED: "실패",
};

export const SEAT_STATUS_LABEL: Record<SeatStatus, string> = {
  AVAILABLE_STANDARD: "일반실 예약 가능",
  AVAILABLE_FIRST: "특실 예약 가능",
  AVAILABLE_ANY: "예약 가능",
  SOLD_OUT: "매진",
  WAITLIST_AVAILABLE: "예약대기 가능",
  AUTH_REQUIRED: "로그인 필요",
  ADDITIONAL_VERIFICATION_REQUIRED: "추가 인증 필요",
  QUEUE_OR_ACCESS_RESTRICTED: "접근 제한",
  PROVIDER_CHANGED: "화면 변경",
  UNKNOWN: "확인 불가",
};

/** 사용자가 직접 무언가 해야 끝나는 상태. UI에서 눈에 띄게 표시한다. */
export const USER_ACTION_REQUIRED_STATES: readonly LiveJobState[] = [
  "RESERVED_PAYMENT_REQUIRED",
  "AUTH_REQUIRED",
  "ADDITIONAL_VERIFICATION_REQUIRED",
  "RESULT_UNCERTAIN_USER_CHECK_REQUIRED",
  "RECONCILIATION_REQUIRED",
];

export const TERMINAL_JOB_STATES: readonly LiveJobState[] = [
  "RESERVED_PAYMENT_REQUIRED",
  "AUTH_REQUIRED",
  "ADDITIONAL_VERIFICATION_REQUIRED",
  "QUEUE_OR_ACCESS_RESTRICTED",
  "PROVIDER_CHANGED",
  "RESULT_UNCERTAIN_USER_CHECK_REQUIRED",
  "RECONCILIATION_REQUIRED",
  "STOPPED_BY_USER",
  "FAILED",
];

export type LiveCandidateView = {
  id: string;
  trainNumber: string;
  departAt: string;
  arriveAt: string;
  state: "PENDING" | "WATCHING" | "SEAT_FOUND" | "RESERVED" | "STOPPED";
  lastSeatStatus: SeatStatus | null;
  /** 화면에서 읽은 원본 문구(개인정보 마스킹·길이 제한 후). */
  lastScreenText: string | null;
  checkedAt: string | null;
  checkCount: number;
};

export type LiveReservationView = {
  confirmed: boolean;
  source?: "reservationList" | "existing";
  trainNumber?: string;
  departAt?: string;
  arriveAt?: string;
  departure?: string;
  arrival?: string;
  date?: string;
  passengers?: number | string;
  seatPreference?: SeatPreference;
  /** 뒤 3자리만 남긴 값. 원문은 Agent 로그에도 남지 않는다. */
  reservationNumber?: string | null;
  paymentDeadline?: { iso: string | null; label: string | null; rawText: string | null } | null;
  evidence?: { source: string; sawSuccessMarker?: boolean; rowText?: string };
  verifiedAt?: string;
};

export type LiveAgentSnapshot = {
  active: boolean;
  provider: { name: string; operator: string; simulation: false };
  config: { livePollingIntervalSeconds: number };
  job?: {
    id: string;
    mode: LiveRunMode;
    state: LiveJobState;
    haltReason: string | null;
    condition: {
      departure: string;
      arrival: string;
      date: string;
      passengers: number | string;
      seatPreference: SeatPreference;
      timeFrom: string | null;
      timeTo: string | null;
    };
    candidates: LiveCandidateView[];
    reservation: LiveReservationView | null;
    checkCount: number;
    startedAt: string;
    updatedAt: string;
    message: string | null;
  };
};

export type LiveJobInput = {
  userId?: string;
  departure: string;
  arrival: string;
  date: string;
  passengers: number | string;
  seatPreference: SeatPreference;
  timeFrom?: string | null;
  timeTo?: string | null;
  candidates: Array<{ id: string; trainNumber: string; departAt: string; arriveAt: string }>;
};

/** 예약 승인 시 화면이 보여준 조건을 그대로 되돌려 보낸다(오예약 방지). */
export type LiveArmEcho = {
  date: string;
  departure: string;
  arrival: string;
  passengers: number | string;
  seatPreference: SeatPreference;
  trainNumbers: string[];
};
