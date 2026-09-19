import "server-only";

import { ReservationProviderError, type JobStatus } from "@/lib/reservation/types";

const TERMINAL_STATES: readonly JobStatus[] = ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"];

// A job can always be cancelled or expire from any non-terminal state, so those
// two edges are added once below rather than repeated in every row.
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ["SCHEDULED"],
  SCHEDULED: ["WATCHING"],
  WATCHING: ["RESERVING", "RATE_LIMITED", "AUTH_REQUIRED", "PROVIDER_CHANGED"],
  RESERVING: ["HELD", "WATCHING", "RATE_LIMITED", "AUTH_REQUIRED", "FAILED"],
  HELD: ["PAYMENT_PENDING"],
  PAYMENT_PENDING: ["COMPLETED"],
  RATE_LIMITED: ["WATCHING"],
  AUTH_REQUIRED: ["WATCHING"],
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

// A job whose expiresAt has passed must never re-enter the reservation path,
// even if a stale Worker message tries to move it back to WATCHING/RESERVING.
export function assertNotExpired(job: { status: JobStatus; expiresAt: string }, now: Date = new Date()): void {
  if (job.status === "EXPIRED" || job.status === "COMPLETED" || job.status === "CANCELLED") return;
  if (new Date(job.expiresAt).getTime() <= now.getTime()) {
    throw new ReservationProviderError("INVALID_TRANSITION", "만료된 작업은 더 이상 진행할 수 없습니다.");
  }
}
