import "server-only";

import { AutomationError, type JobStatus } from "@/lib/automation/types";

// Mirrors lib/reservation/state-machine.ts's shape exactly (canTransition/
// assertTransition/isTerminalStatus/hasExpired), extended with the explicit
// CHECKING_AVAILABILITY/SEAT_FOUND/PURCHASE_CLICKING steps and the extra
// terminal states (§3-B) this version's flow needs.
const TERMINAL_STATES: readonly JobStatus[] = ["SOLD_OUT", "COMPLETED", "CANCELLED", "EXPIRED", "FAILED"];

// Every active (non-terminal) state may also move to CANCELLED, EXPIRED
// (watchUntil passed), or PROVIDER_CHANGED (the configured Provider flag
// changed mid-flight -- same lesson as v0.4's reservation Worker) -- those
// three edges are added once here instead of repeated in every row.
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  SCHEDULED: ["WATCHING"],
  WATCHING: ["CHECKING_AVAILABILITY"],
  CHECKING_AVAILABILITY: ["WATCHING", "SEAT_FOUND", "SOLD_OUT", "RATE_LIMITED", "AUTH_REQUIRED"],
  SEAT_FOUND: ["PURCHASE_CLICKING"],
  PURCHASE_CLICKING: ["RESERVING", "FAILED"],
  RESERVING: ["HELD", "WATCHING", "FAILED"],
  HELD: ["PAYMENT_PENDING"],
  PAYMENT_PENDING: ["COMPLETED", "PAYMENT_EXPIRED"],
  RATE_LIMITED: ["WATCHING"],
  AUTH_REQUIRED: ["WATCHING"],
  PROVIDER_CHANGED: ["FAILED"],
  // (재검토) PAYMENT_EXPIRED는 완전한 terminal이 아니다 -- 결제기한을
  // 놓친 것은 사용자 실수/타이밍 문제일 뿐 감시 자체가 끝난 것은 아니므로,
  // watchUntil이 아직 남아 있다면 "다시 감시"로 새 watchCycle을 시작해 다시
  // WATCHING으로 돌아갈 수 있다(§5 UI의 "다시 감시" 버튼) -- v0.5
  // WatchJob의 SEAT_FOUND->WATCHING과 같은 이유의 예외. CANCELLED/EXPIRED는
  // 여전히 완전한 terminal이다(사용자가 멈췄거나 감시 기한 자체가 끝남).
  PAYMENT_EXPIRED: ["WATCHING"],
  SOLD_OUT: [],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

// PAYMENT_PENDING's own deadline is `paymentDeadline`, checked separately
// (hasPaymentExpired below) -- `watchUntil` never expires a job that has
// already reached PAYMENT_PENDING or a later state.
const WATCH_DEADLINE_APPLIES: readonly JobStatus[] = [
  "SCHEDULED",
  "WATCHING",
  "CHECKING_AVAILABILITY",
  "SEAT_FOUND",
  "PURCHASE_CLICKING",
  "RESERVING",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
];

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false;
  if (isTerminalStatus(from)) return false;
  if (to === "CANCELLED") return true;
  if (to === "EXPIRED") return WATCH_DEADLINE_APPLIES.includes(from);
  if (to === "PROVIDER_CHANGED") return from !== "PROVIDER_CHANGED";
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new AutomationError("INVALID_TRANSITION", `${from} 상태에서 ${to} 상태로 전이할 수 없습니다.`);
  }
}

export function hasExpired(job: { watchUntil: string }, now: Date = new Date()): boolean {
  return new Date(job.watchUntil).getTime() <= now.getTime();
}

export function hasPaymentExpired(job: { paymentDeadline: string | null }, now: Date = new Date()): boolean {
  if (!job.paymentDeadline) return false;
  return new Date(job.paymentDeadline).getTime() <= now.getTime();
}
