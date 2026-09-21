import "server-only";

import { WatchError, type JobStatus } from "@/lib/watch/types";

const TERMINAL_STATES: readonly JobStatus[] = ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"];

// Every active state can be cancelled or (except noted below) expire, so
// those two edges are added once here instead of repeated in every row.
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  REGISTERED: ["WATCHING"],
  WATCHING: ["SEAT_FOUND", "PROVIDER_UNAVAILABLE", "RATE_LIMITED"],
  SEAT_FOUND: ["COMPLETED", "WATCHING"],
  PROVIDER_UNAVAILABLE: ["WATCHING"],
  RATE_LIMITED: ["WATCHING"],
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
  if (to === "EXPIRED") return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new WatchError("INVALID_TRANSITION", `${from} 상태에서 ${to} 상태로 전이할 수 없습니다.`);
  }
}

// Pure predicate: has `watchUntil` passed `now`? The Worker (not this
// function) is responsible for actually persisting the EXPIRED transition --
// see lib/watch/worker.ts and the equivalent lesson learned in v0.4
// (docs/V0.4-ARCHITECTURE.md §2: an exception here is not enough, the state
// must be saved or the UI's "감시 종료" never becomes real).
export function hasExpired(job: { watchUntil: string }, now: Date = new Date()): boolean {
  return new Date(job.watchUntil).getTime() <= now.getTime();
}
