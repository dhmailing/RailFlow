// Pure reducer wiring the Demo Showcase's FSM (state-machine.ts) and
// scenario math (scenarios.ts) into one journey object (types.ts). No
// timers, no storage, no DOM here -- components/demo/demo-showcase.tsx
// drives this reducer from real timers (lib/demo/timer.ts) and persists
// its output (lib/demo/storage.ts). Being pure and side-effect-free is what
// lets scripts/verify-demo-showcase.cjs exercise every transition rule
// (allowed/blocked transitions, seat-found stopping other candidates,
// cancel blocking further transitions, restart resetting cleanly) without
// a browser.
import { assertTransition, canTransition } from "@/lib/demo/state-machine";
import { buildSeatFoundNotification, demoCandidateFixtures, defaultDemoCondition, resolveWatchTick, swapDemoRoute } from "@/lib/demo/scenarios";
import type { DemoIntervalSeconds, DemoJobState, DemoStatus } from "@/lib/demo/types";

export type DemoAction =
  | { type: "SET_DATE"; date: string }
  | { type: "SET_PASSENGERS"; passengers: number }
  | { type: "SWAP_ROUTE" }
  | { type: "TOGGLE_CANDIDATE"; candidateId: string }
  | { type: "SET_INTERVAL"; seconds: number }
  | { type: "REGISTER" }
  | { type: "START_WATCHING" }
  | { type: "TICK" }
  | { type: "MARK_NOTIFIED" }
  | { type: "FINISH" }
  | { type: "CANCEL" }
  | { type: "RESTART_JOURNEY" };

export const DEFAULT_DEMO_INTERVAL_SECONDS: DemoIntervalSeconds = 2;

export function createDefaultDemoState(): DemoJobState {
  const now = new Date().toISOString();
  return {
    condition: defaultDemoCondition(),
    candidates: demoCandidateFixtures(),
    selectedCandidateIds: [],
    status: "READY",
    intervalSeconds: DEFAULT_DEMO_INTERVAL_SECONDS,
    watchTick: 0,
    foundCandidateId: null,
    history: [],
    notifications: [],
    createdAt: now,
    updatedAt: now,
  };
}

// 1~5 사이의 정수만 허용한다(§6). 0, 6, 소수, 문자열로 변환된 값, NaN은
// 전부 거부하고 기존 값을 유지한다 -- 절대 임의로 반올림/clamp하지 않는다.
function isValidIntervalSeconds(value: number): value is DemoIntervalSeconds {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function transition(state: DemoJobState, to: DemoStatus, patch: Partial<DemoJobState> = {}): DemoJobState {
  assertTransition(state.status, to);
  const at = new Date().toISOString();
  return { ...state, ...patch, status: to, updatedAt: at, history: [...state.history, { at, from: state.status, to }] };
}

export function demoReducer(state: DemoJobState, action: DemoAction): DemoJobState {
  switch (action.type) {
    case "SET_DATE": {
      if (state.status !== "READY") return state;
      return { ...state, condition: { ...state.condition, date: action.date }, updatedAt: new Date().toISOString() };
    }
    case "SET_PASSENGERS": {
      if (state.status !== "READY") return state;
      const passengers = Math.min(4, Math.max(1, Math.trunc(action.passengers) || 1));
      return { ...state, condition: { ...state.condition, passengers }, updatedAt: new Date().toISOString() };
    }
    case "SWAP_ROUTE": {
      if (state.status !== "READY") return state;
      return { ...state, condition: swapDemoRoute(state.condition), updatedAt: new Date().toISOString() };
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
    case "REGISTER": {
      if (state.status !== "READY" || state.selectedCandidateIds.length === 0) return state;
      return transition(state, "REGISTERED");
    }
    case "START_WATCHING": {
      if (!canTransition(state.status, "WATCHING")) return state;
      return transition(state, "WATCHING", { watchTick: 0 });
    }
    case "TICK": {
      if (state.status !== "WATCHING") return state;
      const nextTick = state.watchTick + 1;
      const result = resolveWatchTick(state.candidates, state.selectedCandidateIds, nextTick);
      if (result.foundCandidateId) {
        return transition(state, "SEAT_FOUND", {
          candidates: result.candidates,
          foundCandidateId: result.foundCandidateId,
          watchTick: nextTick,
        });
      }
      return { ...state, watchTick: nextTick, updatedAt: new Date().toISOString() };
    }
    case "MARK_NOTIFIED": {
      if (state.status !== "SEAT_FOUND" || !state.foundCandidateId) return state;
      const candidate = state.candidates.find((item) => item.id === state.foundCandidateId);
      if (!candidate) return state;
      const at = new Date().toISOString();
      return transition(state, "NOTIFIED", {
        notifications: [...state.notifications, buildSeatFoundNotification(state.condition, candidate, at)],
      });
    }
    case "FINISH": {
      if (state.status !== "NOTIFIED") return state;
      return transition(state, "FINISHED");
    }
    case "CANCEL": {
      if (state.status === "READY" || !canTransition(state.status, "CANCELLED")) return state;
      return transition(state, "CANCELLED");
    }
    case "RESTART_JOURNEY": {
      // 조건·선택된 후보·시연 간격은 유지한 채 진행 상태만 되돌린다.
      // SEAT_FOUND/NOTIFIED/FINISHED/CANCELLED 등에서 READY로 가는 edge는
      // state-machine.ts에 없다 -- 정방향 전이가 아니라 새 journey를 구성하는
      // 것이므로 transition()을 쓰지 않고 상태를 직접 조립한다.
      const now = new Date().toISOString();
      return {
        ...state,
        candidates: state.candidates.map((candidate) => ({ ...candidate, status: "watching" })),
        status: "READY",
        watchTick: 0,
        foundCandidateId: null,
        history: [],
        notifications: [],
        createdAt: now,
        updatedAt: now,
      };
    }
    default:
      return state;
  }
}
