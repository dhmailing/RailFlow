// Pure one-way state machine for the Demo Showcase job status. Mirrors the
// shape of lib/watch/state-machine.ts (canTransition/assertTransition/
// isTerminalStatus) but is defined independently here -- lib/demo/** must
// never import from lib/watch/** (see lib/demo/types.ts's header comment).
//
// READY -> REGISTERED -> WATCHING -> SEAT_FOUND -> NOTIFIED -> FINISHED
// is the only forward path. Any non-terminal state may additionally move to
// CANCELLED. There is deliberately no SEAT_FOUND/NOTIFIED -> WATCHING edge:
// unlike the real lib/watch state machine, this demo journey never resumes
// in place -- "처음부터 다시 시작" always builds a brand-new READY job
// instead (see lib/demo/reducer.ts), so the forward path stays one-way.
import type { DemoStatus } from "@/lib/demo/types";

const TERMINAL_STATES: readonly DemoStatus[] = ["FINISHED", "CANCELLED"];

const TRANSITIONS: Record<DemoStatus, readonly DemoStatus[]> = {
  READY: ["REGISTERED"],
  REGISTERED: ["WATCHING"],
  WATCHING: ["SEAT_FOUND"],
  SEAT_FOUND: ["NOTIFIED"],
  NOTIFIED: ["FINISHED"],
  FINISHED: [],
  CANCELLED: [],
};

export function isTerminalStatus(status: DemoStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: DemoStatus, to: DemoStatus): boolean {
  if (from === to) return false;
  if (isTerminalStatus(from)) return false;
  if (to === "CANCELLED") return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DemoStatus, to: DemoStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Demo Showcase: ${from} 상태에서 ${to} 상태로 전이할 수 없습니다.`);
  }
}
