import "server-only";

import {
  type AutobookHold,
  type ReservationAttempt,
  type SeatAvailability,
  type SeatReservationProvider,
} from "@/lib/autobook/types";

// 결정론적 Mock Provider — 전체 Worker 흐름을 검증하기 위한 것이다.
//
// 이것은 **시뮬레이션이다.** 외부로 어떤 요청도 보내지 않는다. 화면은
// 이 Provider가 만든 결과를 실제 좌석 상태처럼 보여주면 안 되며,
// `capabilities().simulation === true` 와 job.simulation 플래그가 그 구분을
// 코드로 강제한다.
//
// 왜 결정론적인가: "N번째 조회에서 좌석이 나온다", "예약 응답이 유실된다"
// 같은 시나리오를 테스트가 정확히 재현할 수 있어야 하기 때문이다.
// 무작위성이 있으면 동시성·멱등성 테스트가 흔들린다.

export type MockScenario =
  /** 항상 매진. 감시가 계속 도는지 본다. */
  | { kind: "always_sold_out" }
  /** N번째 조회에서 좌석이 나온다. */
  | { kind: "seat_after"; checks: number; seatClass: "standard" | "first" }
  /** 좌석은 나오지만 예약 순간 이미 사라졌다(경쟁 패배). */
  | { kind: "seat_then_gone"; checks: number }
  /** 예약 요청의 응답이 유실된다. 실제로는 예약이 생겼다. */
  | { kind: "ambiguous_but_reserved"; checks: number }
  /** 예약 요청의 응답이 유실되고, 실제로도 예약이 생기지 않았다. */
  | { kind: "ambiguous_and_absent"; checks: number }
  /** 인증이 만료된다. */
  | { kind: "auth_required" }
  /** 요청 제한에 걸린다. */
  | { kind: "rate_limited"; retryAfterSeconds: number }
  /** 운영자가 차단한다. */
  | { kind: "blocked_by_operator" };

type MockState = {
  /** 후보별 조회 횟수. */
  checks: Map<string, number>;
  /** 멱등키별로 "실제로 생긴 예약". 같은 키로 두 번 불러도 하나만 생긴다. */
  reservations: Map<string, AutobookHold>;
};

const states = new Map<string, MockState>();

function stateOf(jobId: string): MockState {
  let state = states.get(jobId);
  if (!state) {
    state = { checks: new Map(), reservations: new Map() };
    states.set(jobId, state);
  }
  return state;
}

/** 테스트 전용. */
export function resetMockServerProvider(): void {
  states.clear();
}

const scenarios = new Map<string, MockScenario>();

/** 작업별 시나리오를 정한다. 지정하지 않으면 항상 매진이다. */
export function setMockScenario(jobId: string, scenario: MockScenario): void {
  scenarios.set(jobId, scenario);
}

function scenarioOf(jobId: string): MockScenario {
  return scenarios.get(jobId) ?? { kind: "always_sold_out" };
}

function makeHold(
  candidateId: string,
  trainNumber: string,
  departAt: string,
  idempotencyKey: string,
  now: string,
): AutobookHold {
  return {
    candidateId,
    trainNumber,
    departAt,
    // 시뮬레이션임을 값 자체에서도 알 수 있게 한다.
    reservationRef: `SIM-${idempotencyKey.slice(-8).toUpperCase()}`,
    // Mock 이라도 기한을 "지어내지" 않는다는 규칙은 같다: 시뮬레이션에서는
    // 명시적으로 시뮬레이션 기한임을 밝히고 20분을 준다.
    paymentDueAt: new Date(Date.parse(now) + 20 * 60 * 1000).toISOString(),
    officialPaymentUrl: null,
    confirmedBy: "createResponse",
    confirmedAt: now,
  };
}

export const mockServerProvider: SeatReservationProvider = {
  name: "mock-server",

  capabilities: () => ({
    canReadAvailability: true,
    canCreateReservation: true,
    canVerifyReservation: true,
    // 이 값이 true 인 한 화면은 절대 "실제 좌석"이라고 표시하지 않는다.
    simulation: true,
  }),

  async checkAvailability({ job, candidate }): Promise<SeatAvailability> {
    const now = new Date().toISOString();
    const state = stateOf(job.id);
    const count = (state.checks.get(candidate.id) ?? 0) + 1;
    state.checks.set(candidate.id, count);
    const scenario = scenarioOf(job.id);

    switch (scenario.kind) {
      case "always_sold_out":
        return { kind: "SOLD_OUT", observedAt: now };
      case "auth_required":
        // 조회 단계에서도 인증이 풀릴 수 있다. Worker 가 이를 어떻게
        // 다루는지 보려면 여기서도 표현할 수 있어야 한다.
        return { kind: "UNKNOWN", observedAt: now, reason: "AUTH_REQUIRED" };
      case "rate_limited":
        return { kind: "UNKNOWN", observedAt: now, reason: "RATE_LIMITED" };
      case "blocked_by_operator":
        return { kind: "UNKNOWN", observedAt: now, reason: "BLOCKED_BY_OPERATOR" };
      case "seat_after":
      case "seat_then_gone":
      case "ambiguous_but_reserved":
      case "ambiguous_and_absent": {
        const needed = scenario.checks;
        if (count < needed) return { kind: "SOLD_OUT", observedAt: now };
        const seatClass = scenario.kind === "seat_after" ? scenario.seatClass : "standard";
        return { kind: "AVAILABLE", candidateId: candidate.id, seatClass, observedAt: now };
      }
      default:
        return { kind: "UNKNOWN", observedAt: now, reason: "UNHANDLED_SCENARIO" };
    }
  },

  async createReservation({ job, candidate, idempotencyKey }): Promise<ReservationAttempt> {
    const now = new Date().toISOString();
    const state = stateOf(job.id);
    const scenario = scenarioOf(job.id);

    // 멱등성: 같은 키로 이미 만들어진 예약이 있으면 그것을 그대로 돌려준다.
    const existing = state.reservations.get(idempotencyKey);
    if (existing) return { kind: "HELD", hold: existing };

    switch (scenario.kind) {
      case "seat_then_gone":
        return { kind: "GONE", observedAt: now };
      case "auth_required":
        return { kind: "AUTH_REQUIRED", observedAt: now };
      case "rate_limited":
        return { kind: "RATE_LIMITED", observedAt: now, retryAfterSeconds: scenario.retryAfterSeconds };
      case "blocked_by_operator":
        return { kind: "BLOCKED_BY_OPERATOR", observedAt: now, reason: "운영자가 자동화 요청을 차단했습니다." };
      case "ambiguous_but_reserved": {
        // 응답은 잃어버렸지만 예약은 생겼다. findExistingReservation 이
        // 이것을 찾아내야 한다.
        state.reservations.set(
          idempotencyKey,
          makeHold(candidate.id, candidate.trainNumber, candidate.departAt, idempotencyKey, now),
        );
        return { kind: "AMBIGUOUS", observedAt: now, reason: "응답을 받지 못했습니다(시뮬레이션)." };
      }
      case "ambiguous_and_absent":
        return { kind: "AMBIGUOUS", observedAt: now, reason: "응답을 받지 못했습니다(시뮬레이션)." };
      default: {
        const hold = makeHold(candidate.id, candidate.trainNumber, candidate.departAt, idempotencyKey, now);
        state.reservations.set(idempotencyKey, hold);
        return { kind: "HELD", hold };
      }
    }
  },

  async findExistingReservation({ job, idempotencyKey }): Promise<AutobookHold | null> {
    return stateOf(job.id).reservations.get(idempotencyKey) ?? null;
  },
};
