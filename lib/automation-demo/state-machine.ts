// Pure one-way state machine for the public automation macro demo. Mirrors
// the shape of lib/demo/state-machine.ts and (loosely) the real 17-state
// lib/automation/state-machine.ts, but is defined independently here --
// lib/automation-demo/** must never import from lib/automation/** (see
// types.ts's header comment).
//
// READY -> WATCHING -> SEAT_FOUND -> PURCHASE_CLICKING -> RESERVING ->
// PAYMENT_PENDING -> COMPLETED is the only forward path, driven entirely by
// timers once WATCHING starts (§5 "버튼을 추가로 눌러야 하는 방식이 아니라
// 자동 진행") -- PAYMENT_PENDING -> COMPLETED is the one deliberate
// exception, requiring the user's own "결제 완료" click (§5). Any
// non-terminal state may additionally move to CANCELLED. "다시 감시" is not
// a state-machine edge -- like lib/demo's RESTART_JOURNEY, it always builds
// a brand-new WATCHING journey object (reducer.ts's RESTART_WATCH) instead
// of transitioning COMPLETED/CANCELLED back to READY.
import type { AutomationDemoStatus } from "@/lib/automation-demo/types";

const TERMINAL_STATES: readonly AutomationDemoStatus[] = ["COMPLETED", "CANCELLED"];

const TRANSITIONS: Record<AutomationDemoStatus, readonly AutomationDemoStatus[]> = {
  READY: ["WATCHING"],
  WATCHING: ["SEAT_FOUND"],
  SEAT_FOUND: ["PURCHASE_CLICKING"],
  PURCHASE_CLICKING: ["RESERVING"],
  RESERVING: ["PAYMENT_PENDING"],
  PAYMENT_PENDING: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function isTerminalStatus(status: AutomationDemoStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: AutomationDemoStatus, to: AutomationDemoStatus): boolean {
  if (from === to) return false;
  if (isTerminalStatus(from)) return false;
  if (to === "CANCELLED") return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AutomationDemoStatus, to: AutomationDemoStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`자동 좌석조회·예약 매크로 시연: ${from} 상태에서 ${to} 상태로 전이할 수 없습니다.`);
  }
}
