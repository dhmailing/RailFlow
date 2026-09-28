import "server-only";

import { AutobookError, TERMINAL_STATUSES, type AutobookJobStatus } from "@/lib/autobook/types";

// 상태 전이 규칙.
//
// 설계상 가장 중요한 두 가지:
//
//  1. `RESERVATION_CLAIMING` 에서 나가는 길에 "다시 시도"가 없다.
//     예약 요청을 보낸 뒤에는 확정(HELD)·소멸(GONE→WATCHING)·불명확
//     (AMBIGUOUS_RESULT) 중 하나로만 간다. 불명확한 상태에서 재예약하면
//     중복 예약이 생기기 때문이다.
//
//  2. `AMBIGUOUS_RESULT` 는 종료 상태다. 자동으로 빠져나올 수 없고 사람이
//     확인해야 한다.

const TRANSITIONS: Readonly<Record<AutobookJobStatus, readonly AutobookJobStatus[]>> = Object.freeze({
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["WATCHING", "CANCELLED", "EXPIRED"],
  WATCHING: ["SEAT_FOUND", "WATCHING", "CANCELLED", "EXPIRED"],
  SEAT_FOUND: ["RESERVATION_CLAIMING", "WATCHING", "CANCELLED", "EXPIRED"],
  // 예약 요청을 보낸 뒤. 재시도로 돌아가는 길이 없다.
  RESERVATION_CLAIMING: ["RESERVATION_HELD", "WATCHING", "AMBIGUOUS_RESULT", "EXPIRED"],
  RESERVATION_HELD: ["PAYMENT_PENDING", "COMPLETED", "EXPIRED", "CANCELLED"],
  PAYMENT_PENDING: ["COMPLETED", "EXPIRED", "CANCELLED"],
  // 아래는 종료 상태.
  COMPLETED: [],
  EXPIRED: [],
  CANCELLED: [],
  AMBIGUOUS_RESULT: [],
  BLOCKED_BY_OPERATOR: [],
  // 일시 중단 상태. 사용자의 조치 또는 시간이 지나면 감시로 돌아간다.
  AUTH_REQUIRED: ["WATCHING", "CANCELLED", "EXPIRED"],
  RATE_LIMITED: ["WATCHING", "CANCELLED", "EXPIRED"],
  PROVIDER_UNAVAILABLE: ["WATCHING", "CANCELLED", "EXPIRED"],
});

/**
 * 어느 활성 상태에서든 도달할 수 있는 상태.
 *
 * 인증 만료·요청 제한·Provider 중단·운영자 차단은 언제 나타날지 모른다.
 * 이걸 전이표로만 막으면 루프가 그 사실을 삼켜버린다(v0.8에서 실제로 겪었다).
 */
const ALWAYS_REACHABLE: readonly AutobookJobStatus[] = [
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "BLOCKED_BY_OPERATOR",
  "CANCELLED",
  "EXPIRED",
];

/**
 * 예약 요청을 이미 보낸 상태. 여기서는 사용자가 취소를 눌러도 곧바로
 * CANCELLED 가 되지 않는다 -- 예약이 생겼는지 먼저 확인해야 한다.
 */
export const POST_REQUEST_STATUSES: readonly AutobookJobStatus[] = ["RESERVATION_CLAIMING"];

export function isTerminal(status: AutobookJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: AutobookJobStatus, to: AutobookJobStatus): boolean {
  if (isTerminal(from)) return false;
  // 예약 요청을 보낸 뒤에는 "언제든 도달 가능"에서도 CANCELLED 를 뺀다.
  // 결과를 확인하지 않고 취소로 적으면 안 되기 때문이다.
  if (POST_REQUEST_STATUSES.includes(from) && to === "CANCELLED") return false;
  if (ALWAYS_REACHABLE.includes(to)) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: AutobookJobStatus, to: AutobookJobStatus): AutobookJobStatus {
  if (!canTransition(from, to)) {
    throw new AutobookError(
      "INVALID_TRANSITION",
      `허용되지 않는 상태 전이입니다: ${from} -> ${to}`,
    );
  }
  return to;
}

/**
 * 사용자가 취소를 눌렀을 때 실제로 가야 할 상태.
 * 예약 요청을 이미 보냈다면 취소가 아니라 결과 확인으로 보낸다.
 */
export function resolveCancelTarget(current: AutobookJobStatus): AutobookJobStatus {
  if (isTerminal(current)) return current;
  if (POST_REQUEST_STATUSES.includes(current)) return "RESERVATION_CLAIMING";
  return "CANCELLED";
}

/** 화면에 보여줄 한국어 라벨. 실제/시뮬레이션 구분은 별도 배지가 담당한다. */
export const STATUS_LABEL: Readonly<Record<AutobookJobStatus, string>> = Object.freeze({
  DRAFT: "작성 중",
  SCHEDULED: "등록됨",
  WATCHING: "취소표 감시 중",
  SEAT_FOUND: "좌석 발견",
  RESERVATION_CLAIMING: "좌석 확보 요청 중",
  RESERVATION_HELD: "좌석 확보됨 · 결제 필요",
  PAYMENT_PENDING: "결제 대기",
  COMPLETED: "완료",
  EXPIRED: "기한 만료",
  CANCELLED: "취소됨",
  AUTH_REQUIRED: "계정 연결 필요",
  RATE_LIMITED: "요청 제한 · 대기 중",
  PROVIDER_UNAVAILABLE: "공식 연동 준비 중",
  AMBIGUOUS_RESULT: "결과 불명확 · 직접 확인 필요",
  BLOCKED_BY_OPERATOR: "운영자 차단으로 중단",
});
