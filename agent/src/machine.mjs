// 작업 상태 전이 규칙.
//
// 설계 원칙:
//  - 예약 클릭으로 이어지는 경로(SEAT_FOUND -> RESERVING)는 ARMED 모드에서만
//    열린다. 읽기 전용 모드에서는 애초에 전이 자체가 없다.
//  - 중단 상태(§17)는 거의 모든 활성 상태에서 도달할 수 있어야 한다.
//    차단·추가 인증·화면 변경은 언제 나타날지 모르기 때문이다.
//  - 예약 요청을 누른 뒤에는 STOPPED_BY_USER 로 바로 갈 수 없다. 예약이
//    생겼는지 확인하지 않고 "취소됨"으로 적으면 안 되기 때문이다(지침 §12).

import { JobState, RunMode, TERMINAL_JOB_STATES } from "./status.mjs";

/** 언제든 도달 가능한 중단 상태. */
const ALWAYS_REACHABLE = Object.freeze([
  JobState.AUTH_REQUIRED,
  JobState.ADDITIONAL_VERIFICATION_REQUIRED,
  JobState.QUEUE_OR_ACCESS_RESTRICTED,
  JobState.PROVIDER_CHANGED,
  // 기존 예약 발견과 결과 불명확도 여기에 둔다. 예약 직전 확인에서
  // 기존 예약이 나오거나 예상치 못한 결제 화면이 뜨는 일은 어느 단계에서든
  // 일어날 수 있는데, 이걸 기록하지 못하면 루프가 그 사실을 삼켜버린다.
  JobState.RECONCILIATION_REQUIRED,
  JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  JobState.FAILED,
]);

/**
 * 예약 요청 버튼을 이미 누른 뒤의 상태. 여기서는 사용자가 중단을 눌러도
 * 곧바로 STOPPED_BY_USER 가 되지 않고, 먼저 예약내역을 확인한다.
 */
export const POST_RESERVE_CLICK_STATES = Object.freeze([
  JobState.RESERVING,
  JobState.VERIFYING_RESERVATION,
]);

const BASE_TRANSITIONS = Object.freeze({
  [JobState.IDLE]: [JobState.LAUNCHING_BROWSER, JobState.STOPPED_BY_USER],
  [JobState.LAUNCHING_BROWSER]: [JobState.WAITING_MANUAL_LOGIN, JobState.STOPPED_BY_USER],
  [JobState.WAITING_MANUAL_LOGIN]: [JobState.CONNECTED, JobState.STOPPED_BY_USER],
  [JobState.CONNECTED]: [JobState.SEARCHING_TRAIN, JobState.STOPPED_BY_USER],
  [JobState.SEARCHING_TRAIN]: [
    JobState.TRAIN_CONFIRMED,
    JobState.RECONCILIATION_REQUIRED,
    JobState.STOPPED_BY_USER,
  ],
  [JobState.TRAIN_CONFIRMED]: [
    JobState.WATCHING_SOLD_OUT,
    JobState.SEAT_FOUND,
    JobState.SEARCHING_TRAIN,
    JobState.STOPPED_BY_USER,
  ],
  [JobState.WATCHING_SOLD_OUT]: [
    JobState.SEAT_FOUND,
    JobState.SEARCHING_TRAIN,
    JobState.WATCHING_SOLD_OUT,
    JobState.STOPPED_BY_USER,
  ],
  // 읽기 전용 모드에서는 좌석을 찾아도 여기서 멈춘다. ARMED 승인을 기다리는
  // AWAITING_ARM_CONFIRMATION 으로만 갈 수 있고 RESERVING 으로는 못 간다.
  [JobState.SEAT_FOUND]: [
    JobState.AWAITING_ARM_CONFIRMATION,
    JobState.WATCHING_SOLD_OUT,
    JobState.STOPPED_BY_USER,
  ],
  [JobState.AWAITING_ARM_CONFIRMATION]: [
    JobState.WATCHING_SOLD_OUT,
    JobState.STOPPED_BY_USER,
  ],
  [JobState.RESERVING]: [
    JobState.VERIFYING_RESERVATION,
    JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  ],
  [JobState.VERIFYING_RESERVATION]: [
    JobState.RESERVED_PAYMENT_REQUIRED,
    JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
    JobState.WATCHING_SOLD_OUT,
  ],
  // 아래는 모두 종료 상태. 자동으로는 어디로도 가지 않는다.
  [JobState.RESERVED_PAYMENT_REQUIRED]: [],
  [JobState.AUTH_REQUIRED]: [],
  [JobState.ADDITIONAL_VERIFICATION_REQUIRED]: [],
  [JobState.QUEUE_OR_ACCESS_RESTRICTED]: [],
  [JobState.PROVIDER_CHANGED]: [],
  [JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED]: [],
  [JobState.RECONCILIATION_REQUIRED]: [],
  [JobState.STOPPED_BY_USER]: [],
  [JobState.FAILED]: [],
});

/** ARMED 모드에서만 추가로 열리는 전이. */
const ARMED_ONLY_TRANSITIONS = Object.freeze({
  [JobState.SEAT_FOUND]: [JobState.RESERVING],
  [JobState.AWAITING_ARM_CONFIRMATION]: [JobState.RESERVING],
});

export function isTerminal(state) {
  return TERMINAL_JOB_STATES.includes(state);
}

/** 해당 모드에서 from -> to 전이가 허용되는지. */
export function canTransition(from, to, mode = RunMode.LIVE_READ_ONLY) {
  if (!(from in BASE_TRANSITIONS)) return false;
  if (isTerminal(from)) return false;
  if (ALWAYS_REACHABLE.includes(to)) return true;
  if (BASE_TRANSITIONS[from].includes(to)) return true;
  if (mode === RunMode.LIVE_RESERVATION_ARMED) {
    return (ARMED_ONLY_TRANSITIONS[from] ?? []).includes(to);
  }
  return false;
}

export class TransitionError extends Error {
  constructor(from, to, mode) {
    super(`허용되지 않는 상태 전이입니다: ${from} -> ${to} (mode=${mode})`);
    this.name = "TransitionError";
    this.code = "INVALID_TRANSITION";
    this.from = from;
    this.to = to;
    this.mode = mode;
  }
}

export function assertTransition(from, to, mode = RunMode.LIVE_READ_ONLY) {
  if (!canTransition(from, to, mode)) throw new TransitionError(from, to, mode);
  return to;
}

/**
 * 사용자가 중단을 눌렀을 때 실제로 가야 할 상태.
 * 예약 요청을 이미 누른 뒤라면 곧바로 "중단"으로 적지 않고, 예약내역을
 * 확인하는 단계로 보낸다(지침 §12).
 */
export function resolveUserStopTarget(current) {
  if (isTerminal(current)) return current;
  if (POST_RESERVE_CLICK_STATES.includes(current)) return JobState.VERIFYING_RESERVATION;
  return JobState.STOPPED_BY_USER;
}
