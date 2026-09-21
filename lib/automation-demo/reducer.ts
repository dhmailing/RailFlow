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
  resolveCheckTick,
} from "@/lib/automation-demo/scenarios";
import type { AutomationDemoIntervalSeconds, AutomationDemoState, AutomationDemoStatus } from "@/lib/automation-demo/types";

export type AutomationDemoAction =
  | { type: "SET_DATE"; date: string }
  | { type: "SET_TIME_RANGE_START"; time: string }
  | { type: "SET_TIME_RANGE_END"; time: string }
  | { type: "TOGGLE_CANDIDATE"; candidateId: string }
  | { type: "SET_INTERVAL"; seconds: number }
  | { type: "START_WATCHING" }
  | { type: "TICK" }
  | { type: "ADVANCE_TO_PURCHASE_CLICKING" }
  | { type: "ADVANCE_TO_RESERVING" }
  | { type: "COMPLETE_RESERVATION" }
  | { type: "CONFIRM_PAYMENT" }
  | { type: "CANCEL" }
  | { type: "RESTART_WATCH" };

export const DEFAULT_AUTOMATION_DEMO_INTERVAL_SECONDS: AutomationDemoIntervalSeconds = 1;
// §4 "후보 2개 이상 선택".
export const MIN_SELECTED_CANDIDATES = 2;

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
      return { ...state, condition: { ...state.condition, timeRangeStart: action.time }, updatedAt: new Date().toISOString() };
    }
    case "SET_TIME_RANGE_END": {
      if (state.status !== "READY") return state;
      return { ...state, condition: { ...state.condition, timeRangeEnd: action.time }, updatedAt: new Date().toISOString() };
    }
    case "TOGGLE_CANDIDATE": {
      if (state.status !== "READY") return state;
      const selected = state.selectedCandidateIds.includes(action.candidateId)
        ? state.selectedCandidateIds.filter((id) => id !== action.candidateId)
        : [...state.selectedCandidateIds, action.candidateId];
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
      const result = resolveCheckTick(state.candidates, state.selectedCandidateIds, tickIndex);
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
      return transition(state, "COMPLETED", (at) => ({ endedAt: at }));
    }
    case "CANCEL": {
      if (state.status === "READY" || !canTransition(state.status, "CANCELLED")) return state;
      return transition(state, "CANCELLED", (at) => ({ endedAt: at }));
    }
    case "RESTART_WATCH": {
      // 조건·선택된 후보·간격은 유지한 채 진행 상태만 새로 시작한다 --
      // state-machine.ts에 COMPLETED/CANCELLED -> READY/WATCHING edge가
      // 없으므로(정방향 전이가 아니라 새 journey 구성) transition()을 쓰지
      // 않고 직접 조립한다(lib/demo/reducer.ts의 RESTART_JOURNEY와 동일한
      // 원칙).
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
