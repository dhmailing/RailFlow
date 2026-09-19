import "server-only";

import { ReservationProviderError, type JobStatus } from "@/lib/reservation/types";

const TERMINAL_STATES: readonly JobStatus[] = ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"];

// A job can always be cancelled or expire from any non-terminal state, so those
// two edges are added once below rather than repeated in every row. Every
// active (non-terminal) state also allows PROVIDER_CHANGED: the Worker checks
// RAIL_RESERVATION_PROVIDER against job.provider before doing anything else on
// every tick, so a mid-flight flag change must be representable no matter
// which active state the job was in when it happened (see worker.ts).
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ["SCHEDULED", "PROVIDER_CHANGED"],
  SCHEDULED: ["WATCHING", "PROVIDER_CHANGED"],
  WATCHING: ["RESERVING", "RATE_LIMITED", "AUTH_REQUIRED", "PROVIDER_CHANGED"],
  RESERVING: ["HELD", "WATCHING", "RATE_LIMITED", "AUTH_REQUIRED", "FAILED", "PROVIDER_CHANGED"],
  HELD: ["PAYMENT_PENDING", "PROVIDER_CHANGED"],
  PAYMENT_PENDING: ["COMPLETED", "PROVIDER_CHANGED"],
  RATE_LIMITED: ["WATCHING", "PROVIDER_CHANGED"],
  AUTH_REQUIRED: ["WATCHING", "PROVIDER_CHANGED"],
  PROVIDER_CHANGED: ["FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false;
  if (isTerminalStatus(from)) return false;
  if (to === "CANCELLED") return true;
  if (to === "EXPIRED") return from !== "COMPLETED";
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new ReservationProviderError(
      "INVALID_TRANSITION",
      `${from} 상태에서 ${to} 상태로 전이할 수 없습니다.`,
    );
  }
}

// Pure check: does the watch/search deadline (`expiresAt`) fall at or before
// `now`? This governs DRAFT/SCHEDULED/WATCHING/RESERVING/RATE_LIMITED/
// AUTH_REQUIRED/HELD -- never PAYMENT_PENDING, whose own deadline is
// `holdExpiresAt` and which this PR does not auto-expire (see worker.ts and
// docs/V0.4-ARCHITECTURE.md). The caller (worker.runStep) is responsible for
// actually persisting the EXPIRED transition; this function only answers the
// yes/no question so a stale message can never advance an expired job further.
export function hasExpired(job: { expiresAt: string }, now: Date = new Date()): boolean {
  return new Date(job.expiresAt).getTime() <= now.getTime();
}
