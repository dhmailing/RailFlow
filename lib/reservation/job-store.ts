import "server-only";

import { assertTransition, isTerminalStatus } from "@/lib/reservation/state-machine";
import {
  ReservationProviderError,
  type JobStatus,
  type ReservationErrorCode,
  type ReservationJob,
  type ReservationJobInput,
} from "@/lib/reservation/types";

// Process-memory only. It resets on every cold start/redeploy and is never
// shared across serverless instances -- acceptable for a demo/foundation PR,
// never for production job durability. A real deployment must move this to
// PostgreSQL/Redis (see docs/adr for the comparison) before ENABLE_RESERVATION_JOBS
// is turned on anywhere but a test environment.
const jobs = new Map<string, ReservationJob>();

function dedupeKey(input: Pick<ReservationJobInput, "userId" | "departureId" | "arrivalId" | "date" | "passengers">): string {
  return [input.userId, input.departureId, input.arrivalId, input.date, input.passengers].join("|");
}

function hasActiveDuplicate(input: ReservationJobInput): boolean {
  const key = dedupeKey(input);
  for (const job of jobs.values()) {
    if (isTerminalStatus(job.status)) continue;
    if (dedupeKey(job) === key) return true;
  }
  return false;
}

export function createJob(input: ReservationJobInput, provider: "mock" | "official"): ReservationJob {
  if (hasActiveDuplicate(input)) {
    throw new ReservationProviderError(
      "DUPLICATE_JOB",
      "같은 사용자·날짜·구간·인원의 자동예약 작업이 이미 진행 중입니다.",
    );
  }

  const now = new Date().toISOString();
  const job: ReservationJob = {
    ...input,
    id: crypto.randomUUID(),
    status: "DRAFT",
    provider,
    createdAt: now,
    updatedAt: now,
    heldCandidateId: null,
    attempts: 0,
    lastError: null,
    history: [{ at: now, from: null, to: "DRAFT", reason: "작업 생성" }],
  };

  jobs.set(job.id, job);
  return job;
}

export function listJobs(userId: string): ReservationJob[] {
  return [...jobs.values()]
    .filter((job) => job.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string, userId: string): ReservationJob {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) {
    throw new ReservationProviderError("NOT_FOUND", "예약 작업을 찾을 수 없습니다.");
  }
  return job;
}

export type TransitionPatch = Partial<Pick<ReservationJob, "heldCandidateId" | "attempts" | "lastError">>;

export function transitionJob(
  id: string,
  userId: string,
  to: JobStatus,
  reason: string,
  patch: TransitionPatch = {},
): ReservationJob {
  const job = getJob(id, userId);
  assertTransition(job.status, to);

  const now = new Date().toISOString();
  const updated: ReservationJob = {
    ...job,
    ...patch,
    status: to,
    updatedAt: now,
    history: [...job.history, { at: now, from: job.status, to, reason }],
  };
  jobs.set(id, updated);
  return updated;
}

// Increments the attempt counter on every Worker tick and records (or clears,
// with `null`) the last error, without moving the job's status.
export function recordAttempt(
  id: string,
  userId: string,
  error: { code: ReservationErrorCode; message: string } | null,
): ReservationJob {
  const job = getJob(id, userId);
  const updated: ReservationJob = {
    ...job,
    attempts: job.attempts + 1,
    lastError: error,
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, updated);
  return updated;
}

export function cancelJob(id: string, userId: string, reason = "사용자 취소"): ReservationJob {
  return transitionJob(id, userId, "CANCELLED", reason);
}

// Test-only: clears all in-memory jobs so scripts/verify-reservation.cjs can
// run independent scenarios without cross-contaminating dedupe checks.
export function __resetJobStoreForTests(): void {
  jobs.clear();
}
