// Pure reducer wiring the automation macro demo's FSM (state-machine.ts)
// and scenario math (scenarios.ts) into one journey object (types.ts). No
// timers, no storage, no DOM here -- components/automation-demo/
// booking-automation-demo.tsx drives this reducer from real timers
// (timer.ts) and persists its output (storage.ts). Being pure and
// side-effect-free is what lets scripts/verify-automation-demo.cjs
// exercise every transition rule without a browser.
import { assertTransition, canTransition } from "@/lib/automation-demo/state-machine";
import {
  automationDemoCandidateFixtures,
  computeVirtualPaymentDeadline,
  defaultAutomationDemoCondition,
  generateVirtualReservationNumber,
  isCandidateEligible,
  resolveCheckTick,
} from "@/lib/automation-demo/scenarios";
import type { AutomationDemoIntervalSeconds, AutomationDemoSeatClassPreference, AutomationDemoState, AutomationDemoStatus } from "@/lib/automation-demo/types";

export type AutomationDemoAction =
  | { type: "SET_DATE"; date: string }
  | { type: "SET_TIME_RANGE_START"; time: string }
  | { type: "SET_TIME_RANGE_END"; time: string }
  | { type: "SET_PASSENGERS"; passengers: number }
  | { type: "SET_SEAT_CLASS_PREFERENCE"; preference: AutomationDemoSeatClassPreference }
  | { type: "TOGGLE_CANDIDATE"; candidateId: string }
  | { type: "SET_INTERVAL"; seconds: number }
  | { type: "START_WATCHING" }
  | { type: "TICK" }
  | { type: "ADVANCE_TO_PURCHASE_CLICKING" }
  | { type: "ADVANCE_TO_RESERVING" }
  | { type: "COMPLETE_RESERVATION" }
  | { type: "CONFIRM_PAYMENT" }
  | { type: "EXPIRE_PAYMENT" }
  | { type: "CANCEL" }
  | { type: "RESTART_WATCH" };

export const DEFAULT_AUTOMATION_DEMO_INTERVAL_SECONDS: AutomationDemoIntervalSeconds = 1;
// 1단계 결함 수정: 후보 0개는 감시할 대상이 없으므로 시작을 막지만,
// 원하는 열차 한 편만 골라 감시하는 것도 정상 시나리오이므로 2개 이상을
// 강제하지 않는다. 후보가 여러 개면 그중 하나가 예약에 성공했을 때
// 나머지를 자동 중단하는 기존 동작(resolveCheckTick)은 그대로 유지된다.
export const MIN_SELECTED_CANDIDATES = 1;
export const MIN_PASSENGERS = 1;
export const MAX_PASSENGERS = 4;

export function createDefaultAutomationDemoState(): AutomationDemoState {
  const now = new Date().toISOString();
  return {
    condition: defaultAutomationDemoCondition(),
    candidates: automationDemoCandidateFixtures(),
    selectedCandidateIds: [],
    status: "READY",
    intervalSeconds: DEFAULT_AUTOMATION_DEMO_INTERVAL_SECONDS,
    watchTick: 0,
    foundCandidateId: null,
    reservationNumber: null,
    paymentDeadline: null,
    history: [],
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
  };
}

// 경과 시간의 유일한 계산 지점 -- lib/demo/reducer.ts의 computeElapsedSeconds와
// 동일한 규칙: startedAt이 없으면 0, endedAt이 있으면 그 값에서 고정, 그 외는
// nowMs 기준으로 계속 흐른다.
export function computeElapsedSeconds(state: Pick<AutomationDemoState, "startedAt" | "endedAt">, nowMs: number = Date.now()): number {
  if (!state.startedAt) return 0;
  const startedMs = new Date(state.startedAt).getTime();
  const endMs = state.endedAt ? new Date(state.endedAt).getTime() : nowMs;
  return Math.max(0, Math.floor((endMs - startedMs) / 1000));
}

function isValidIntervalSeconds(value: number): value is AutomationDemoIntervalSeconds {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function isValidPassengers(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PASSENGERS && value <= MAX_PASSENGERS;
}

// 조건(희망 시간대/좌석등급)이 바뀌어 더 이상 선택할 수 없게 된 후보는
// 선택 목록에서 제거한다 -- §3 "입력한... 좌석등급이 실제 후보 선정에
// 반영되는지" 요구사항을 조건 변경 시점에도 지킨다(이미 선택된 채로
// 남아있으면 안 된다).
function dropIneligibleSelections(state: AutomationDemoState): string[] {
  return state.selectedCandidateIds.filter((id) => {
    const candidate = state.candidates.find((c) => c.id === id);
    return candidate ? isCandidateEligible(candidate, state.condition) : false;
  });
}

function transition(state: AutomationDemoState, to: AutomationDemoStatus, patchFactory: (at: string) => Partial<AutomationDemoState> = () => ({})): AutomationDemoState {
  assertTransition(state.status, to);
  const at = new Date().toISOString();
  return { ...state, ...patchFactory(at), status: to, updatedAt: at, history: [...state.history, { at, from: state.status, to }] };
}

export function automationDemoReducer(state: AutomationDemoState, action: AutomationDemoAction): AutomationDemoState {
  switch (action.type) {
    case "SET_DATE": {
      if (state.status !== "READY") return state;
      return { ...state, condition: { ...state.condition, date: action.date }, updatedAt: new Date().toISOString() };
    }
    case "SET_TIME_RANGE_START": {
      if (state.status !== "READY") return state;
      const next = { ...state, condition: { ...state.condition, timeRangeStart: action.time }, updatedAt: new Date().toISOString() };
      return { ...next, selectedCandidateIds: dropIneligibleSelections(next) };
    }
    case "SET_TIME_RANGE_END": {
      if (state.status !== "READY") return state;
      const next = { ...state, condition: { ...state.condition, timeRangeEnd: action.time }, updatedAt: new Date().toISOString() };
      return { ...next, selectedCandidateIds: dropIneligibleSelections(next) };
    }
    case "SET_PASSENGERS": {
      if (state.status !== "READY" || !isValidPassengers(action.passengers)) return state;
      return { ...state, condition: { ...state.condition, passengers: action.passengers }, updatedAt: new Date().toISOString() };
    }
    case "SET_SEAT_CLASS_PREFERENCE": {
      if (state.status !== "READY") return state;
      const next = { ...state, condition: { ...state.condition, seatClassPreference: action.preference }, updatedAt: new Date().toISOString() };
      return { ...next, selectedCandidateIds: dropIneligibleSelections(next) };
    }
    case "TOGGLE_CANDIDATE": {
      if (state.status !== "READY") return state;
      const alreadySelected = state.selectedCandidateIds.includes(action.candidateId);
      if (!alreadySelected) {
        // §3: 희망 시간대·좌석등급 밖의 후보는 선택 자체가 불가능해야 한다
        // (UI가 체크박스를 비활성화하는 것과 별개로, reducer 스스로도
        // 방어적으로 막는다).
        const candidate = state.candidates.find((c) => c.id === action.candidateId);
        if (!candidate || !isCandidateEligible(candidate, state.condition)) return state;
      }
      const selected = alreadySelected ? state.selectedCandidateIds.filter((id) => id !== action.candidateId) : [...state.selectedCandidateIds, action.candidateId];
      return { ...state, selectedCandidateIds: selected, updatedAt: new Date().toISOString() };
    }
    case "SET_INTERVAL": {
      if (!isValidIntervalSeconds(action.seconds)) return state;
      return { ...state, intervalSeconds: action.seconds, updatedAt: new Date().toISOString() };
    }
    case "START_WATCHING": {
      if (state.status !== "READY" || state.selectedCandidateIds.length < MIN_SELECTED_CANDIDATES) return state;
      return transition(state, "WATCHING", (at) => ({ startedAt: at, watchTick: 0 }));
    }
    case "TICK": {
      if (state.status !== "WATCHING") return state;
      const tickIndex = state.watchTick;
      const result = resolveCheckTick(state.candidates, state.selectedCandidateIds, tickIndex, state.condition.passengers);
      if (result.foundCandidateId) {
        return transition(state, "SEAT_FOUND", () => ({
          candidates: result.candidates,
          foundCandidateId: result.foundCandidateId,
          watchTick: tickIndex + 1,
        }));
      }
      return { ...state, candidates: result.candidates, watchTick: tickIndex + 1, updatedAt: new Date().toISOString() };
    }
    case "ADVANCE_TO_PURCHASE_CLICKING": {
      if (state.status !== "SEAT_FOUND") return state;
      return transition(state, "PURCHASE_CLICKING");
    }
    case "ADVANCE_TO_RESERVING": {
      if (state.status !== "PURCHASE_CLICKING") return state;
      return transition(state, "RESERVING");
    }
    case "COMPLETE_RESERVATION": {
      if (state.status !== "RESERVING") return state;
      return transition(state, "PAYMENT_PENDING", (at) => ({
        reservationNumber: generateVirtualReservationNumber(),
        paymentDeadline: computeVirtualPaymentDeadline(new Date(at).getTime()),
      }));
    }
    case "CONFIRM_PAYMENT": {
      if (state.status !== "PAYMENT_PENDING") return state;
      // 1단계 결함 수정: "결제기한이 지난 가상 예약을 결제 완료로 변경할 수
      // 없게 한다" -- 정상 경로에서는 타이머(EXPIRE_PAYMENT)가 먼저
      // PAYMENT_EXPIRED로 옮겨놓아 이 액션 자체가 무의미해지지만, 시스템
      // 시계 변경이나 백그라운드 탭에서 타이머가 지연된 경우를 대비해 여기
      // 에서도 한 번 더 확인한다(방어적 이중 검증).
      if (state.paymentDeadline && new Date(state.paymentDeadline).getTime() < Date.now()) return state;
      return transition(state, "COMPLETED", (at) => ({ endedAt: at }));
    }
    case "EXPIRE_PAYMENT": {
      if (state.status !== "PAYMENT_PENDING") return state;
      if (!state.paymentDeadline || new Date(state.paymentDeadline).getTime() > Date.now()) return state;
      return transition(state, "PAYMENT_EXPIRED", (at) => ({ endedAt: at }));
    }
    case "CANCEL": {
      if (state.status === "READY" || !canTransition(state.status, "CANCELLED")) return state;
      return transition(state, "CANCELLED", (at) => ({ endedAt: at }));
    }
    case "RESTART_WATCH": {
      // 조건·선택된 후보·간격은 유지한 채 진행 상태만 새로 시작한다 --
      // state-machine.ts에 COMPLETED/CANCELLED/PAYMENT_EXPIRED ->
      // READY/WATCHING edge가 없으므로(정방향 전이가 아니라 새 journey
      // 구성) transition()을 쓰지 않고 직접 조립한다(lib/demo/reducer.ts의
      // RESTART_JOURNEY와 동일한 원칙). COMPLETED 또는 PAYMENT_EXPIRED에서만
      // 의미가 있다(둘 다 UI에 "다시 감시" 버튼이 있다).
      if (state.status !== "COMPLETED" && state.status !== "PAYMENT_EXPIRED") return state;
      const now = new Date().toISOString();
      return {
        ...state,
        candidates: state.candidates.map((candidate) => ({ ...candidate, status: "waiting", checkCount: 0 })),
        status: "WATCHING",
        watchTick: 0,
        foundCandidateId: null,
        reservationNumber: null,
        paymentDeadline: null,
        history: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        endedAt: null,
      };
    }
    default:
      return state;
  }
}
