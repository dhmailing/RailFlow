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
    startedAt: null,
    endedAt: null,
  };
}

// 경과 시간의 유일한 계산 지점(재검토 §1). nowMs를 인자로 받는 순수 함수라
// 실제 시계에 의존하지 않고 결정론적으로 테스트할 수 있다
// (scripts/verify-demo-showcase.cjs). 규칙:
//   - startedAt이 없으면(READY) 항상 0.
//   - endedAt이 있으면(FINISHED/CANCELLED) "endedAt - startedAt"으로 고정 --
//     nowMs가 아무리 흘러도 더 이상 증가하지 않는다.
//   - 그 외(REGISTERED/WATCHING/SEAT_FOUND/NOTIFIED)는 "nowMs - startedAt".
export function computeElapsedSeconds(state: Pick<DemoJobState, "startedAt" | "endedAt">, nowMs: number = Date.now()): number {
  if (!state.startedAt) return 0;
  const startedMs = new Date(state.startedAt).getTime();
  const endMs = state.endedAt ? new Date(state.endedAt).getTime() : nowMs;
  return Math.max(0, Math.floor((endMs - startedMs) / 1000));
}

// 1~5 사이의 정수만 허용한다(§6). 0, 6, 소수, 문자열로 변환된 값, NaN은
// 전부 거부하고 기존 값을 유지한다 -- 절대 임의로 반올림/clamp하지 않는다.
function isValidIntervalSeconds(value: number): value is DemoIntervalSeconds {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function transition(state: DemoJobState, to: DemoStatus, patchFactory: (at: string) => Partial<DemoJobState> = () => ({})): DemoJobState {
  assertTransition(state.status, to);
  const at = new Date().toISOString();
  return { ...state, ...patchFactory(at), status: to, updatedAt: at, history: [...state.history, { at, from: state.status, to }] };
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
      // startedAt은 여기서만 설정된다 -- READY 상태에서 후보를 고르며 머문
      // 시간은 이 시점 이전이므로 경과 시간에 포함되지 않는다. 재시작 등으로
      // 이전 값이 남아 있더라도 매번 이 시점의 새 값으로 덮어쓴다.
      return transition(state, "REGISTERED", (at) => ({ startedAt: at }));
    }
    case "START_WATCHING": {
      if (!canTransition(state.status, "WATCHING")) return state;
      return transition(state, "WATCHING", () => ({ watchTick: 0 }));
    }
    case "TICK": {
      if (state.status !== "WATCHING") return state;
      const nextTick = state.watchTick + 1;
      const result = resolveWatchTick(state.candidates, state.selectedCandidateIds, nextTick);
      if (result.foundCandidateId) {
        return transition(state, "SEAT_FOUND", () => ({
          candidates: result.candidates,
          foundCandidateId: result.foundCandidateId,
          watchTick: nextTick,
        }));
      }
      return { ...state, watchTick: nextTick, updatedAt: new Date().toISOString() };
    }
    case "MARK_NOTIFIED": {
      if (state.status !== "SEAT_FOUND" || !state.foundCandidateId) return state;
      const candidate = state.candidates.find((item) => item.id === state.foundCandidateId);
      if (!candidate) return state;
      return transition(state, "NOTIFIED", (at) => ({
        notifications: [...state.notifications, buildSeatFoundNotification(state.condition, candidate, at)],
      }));
    }
    case "FINISH": {
      if (state.status !== "NOTIFIED") return state;
      // endedAt을 고정한다 -- 이후 computeElapsedSeconds는 이 값을 상한으로
      // 써서 경과 시간이 더 이상 증가하지 않는다.
      return transition(state, "FINISHED", (at) => ({ endedAt: at }));
    }
    case "CANCEL": {
      if (state.status === "READY" || !canTransition(state.status, "CANCELLED")) return state;
      return transition(state, "CANCELLED", (at) => ({ endedAt: at }));
    }
    case "RESTART_JOURNEY": {
      // 조건·선택된 후보·시연 간격은 유지한 채 진행 상태만 되돌린다.
      // SEAT_FOUND/NOTIFIED/FINISHED/CANCELLED 등에서 READY로 가는 edge는
      // state-machine.ts에 없다 -- 정방향 전이가 아니라 새 journey를 구성하는
      // 것이므로 transition()을 쓰지 않고 상태를 직접 조립한다. startedAt/
      // endedAt도 함께 지워야 다음 "가상 감시 시작"이 새 시작 시각을 쓴다.
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
        startedAt: null,
        endedAt: null,
      };
    }
    default:
      return state;
  }
}
