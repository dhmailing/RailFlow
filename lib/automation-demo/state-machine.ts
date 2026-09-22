// Pure one-way state machine for the public automation macro demo. Mirrors
// the shape of lib/demo/state-machine.ts and (loosely) the real 17-state
// lib/automation/state-machine.ts, but is defined independently here --
// lib/automation-demo/** must never import from lib/automation/** (see
// types.ts's header comment).
//
// READY -> WATCHING -> SEAT_FOUND -> PURCHASE_CLICKING -> RESERVING ->
// PAYMENT_PENDING -> COMPLETED is the only forward path, driven entirely by
// timers once WATCHING starts (§5 "버튼을 추가로 눌러야 하는 방식이 아니라
// 자동 진행") -- PAYMENT_PENDING -> COMPLETED is one deliberate exception,
// requiring the user's own "결제 완료" click (§5). PAYMENT_PENDING ->
// PAYMENT_EXPIRED is the other -- an automatic timer-driven transition when
// the virtual payment deadline passes (1단계 결함 수정: "결제기한이 지난
// 가상 예약을 결제 완료로 변경할 수 없게 한다"). PAYMENT_EXPIRED is
// deliberately *not* in TERMINAL_STATES, mirroring the real
// lib/automation/state-machine.ts's one non-terminal exception -- it never
// gets a further TRANSITIONS entry here (nothing auto-advances out of it),
// but "다시 감시" (reducer.ts's RESTART_WATCH) can still start a fresh
// journey from it, exactly like from COMPLETED/CANCELLED. Any non-terminal
// state may additionally move to CANCELLED. "다시 감시" is not itself a
// state-machine edge -- like lib/demo's RESTART_JOURNEY, it always builds a
// brand-new WATCHING journey object instead of transitioning
// COMPLETED/CANCELLED/PAYMENT_EXPIRED back to READY.
import type { AutomationDemoStatus } from "@/lib/automation-demo/types";

const TERMINAL_STATES: readonly AutomationDemoStatus[] = ["COMPLETED", "CANCELLED"];

const TRANSITIONS: Record<AutomationDemoStatus, readonly AutomationDemoStatus[]> = {
  READY: ["WATCHING"],
  WATCHING: ["SEAT_FOUND"],
  SEAT_FOUND: ["PURCHASE_CLICKING"],
  PURCHASE_CLICKING: ["RESERVING"],
  RESERVING: ["PAYMENT_PENDING"],
  PAYMENT_PENDING: ["COMPLETED", "PAYMENT_EXPIRED"],
  COMPLETED: [],
  PAYMENT_EXPIRED: [],
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
