import "server-only";

import { assertTransition, isTerminalStatus } from "@/lib/automation/state-machine";
import {
  AutomationError,
  type AutomationCandidate,
  type AutomationErrorCode,
  type AutomationJob,
  type AutomationJobInput,
  type JobStatus,
} from "@/lib/automation/types";

// Process-memory only, exactly like lib/reservation/job-store.ts and
// lib/watch/store.ts -- resets on every cold start, never shared across
// serverless instances. A real deployment needs PostgreSQL (see
// docs/V0.7-BOOKING-MACRO-SIMULATOR.md) before this ever runs anywhere but
// a test/demo environment, which is exactly what SEAT_AUTOMATION_PROVIDER's
// production-blocked default already enforces independently.
const jobs = new Map<string, AutomationJob>();

function dedupeKey(input: Pick<AutomationJobInput, "userId" | "departure" | "arrival" | "date" | "passengers">): string {
  return [input.userId, input.departure, input.arrival, input.date, input.passengers].join("|");
}

function hasActiveDuplicate(input: AutomationJobInput): boolean {
  const key = dedupeKey(input);
  for (const job of jobs.values()) {
    if (isTerminalStatus(job.status)) continue;
    if (dedupeKey(job) === key) return true;
  }
  return false;
}

function validateCandidates(candidates: AutomationCandidate[]): void {
  if (candidates.length === 0) {
    throw new AutomationError("INVALID_CANDIDATE", "후보 열차를 하나 이상 선택해주세요.");
  }
  const ids = candidates.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    throw new AutomationError("INVALID_CANDIDATE", "후보 열차 id가 중복되었습니다.");
  }
}

export function createJob(input: AutomationJobInput, provider: "mock-browser" | "mock-direct" | "unavailable" | "official"): AutomationJob {
  validateCandidates(input.candidates);
  if (hasActiveDuplicate(input)) {
    throw new AutomationError("DUPLICATE_JOB", "같은 사용자·날짜·구간·인원의 자동화 작업이 이미 진행 중입니다.");
  }

  const now = new Date().toISOString();
  const job: AutomationJob = {
    ...input,
    id: crypto.randomUUID(),
    status: "SCHEDULED",
    provider,
    simulation: provider === "mock-browser",
    watchCycle: 1,
    attempts: 0,
    lastCheckedAt: null,
    nextCheckAt: null,
    seatFoundAt: null,
    purchaseClickedAt: null,
    reservedAt: null,
    heldCandidateId: null,
    reservationNumber: null,
    paymentDeadline: null,
    definitiveSoldOutCandidateIds: [],
    stepClaimToken: null,
    stepLockExpiresAt: null,
    reservedForCycle: null,
    notifiedForCycle: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, from: null, to: "SCHEDULED", reason: "작업 생성" }],
  };

  jobs.set(job.id, job);
  return job;
}

export function listJobs(userId: string): AutomationJob[] {
  return [...jobs.values()].filter((job) => job.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string, userId: string): AutomationJob {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) {
    throw new AutomationError("NOT_FOUND", "자동화 작업을 찾을 수 없습니다.");
  }
  return job;
}

export type TransitionPatch = Partial<
  Pick<
    AutomationJob,
    | "lastCheckedAt"
    | "nextCheckAt"
    | "seatFoundAt"
    | "purchaseClickedAt"
    | "reservedAt"
    | "heldCandidateId"
    | "reservationNumber"
    | "paymentDeadline"
    | "attempts"
    | "lastError"
    | "reservedForCycle"
    | "notifiedForCycle"
  >
>;

export function transitionJob(id: string, userId: string, to: JobStatus, reason: string, patch: TransitionPatch = {}): AutomationJob {
  const job = getJob(id, userId);
  assertTransition(job.status, to);

  const now = new Date().toISOString();
  const updated: AutomationJob = {
    ...job,
    ...patch,
    status: to,
    updatedAt: now,
    history: [...job.history, { at: now, from: job.status, to, reason }],
  };
  jobs.set(id, updated);
  return updated;
}

// Increments the attempt counter and records the next scheduled check time
// (§5 UI: "다음 조회까지 남은 시간") without moving the job's status --
// mirrors lib/reservation/job-store.ts's recordAttempt.
export function recordAttempt(id: string, userId: string, error: { code: AutomationErrorCode; message: string } | null, nextCheckAt: string | null): AutomationJob {
  const job = getJob(id, userId);
  const now = new Date().toISOString();
  const updated: AutomationJob = {
    ...job,
    attempts: job.attempts + 1,
    lastCheckedAt: now,
    nextCheckAt,
    lastError: error,
    updatedAt: now,
  };
  jobs.set(id, updated);
  return updated;
}

function generateClaimToken(): string {
  return crypto.randomUUID();
}

// (§6 동시성) Default lease -- how long a Worker has to finish clickPurchase()
// + reserve() before another Worker is allowed to reclaim the same job's
// step. Ignored in real Production exactly like
// lib/watch/store.ts's NOTIFICATION_CLAIM_LEASE_MS override (see the same
// fail-closed reasoning there): a test may shorten this, but real
// Production always uses the fixed default regardless of any env var.
const DEFAULT_STEP_LEASE_MS = 20_000;

function getStepLeaseMs(): number {
  if (process.env.VERCEL_ENV === "production") return DEFAULT_STEP_LEASE_MS;
  const override = Number(process.env.AUTOMATION_STEP_LEASE_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_STEP_LEASE_MS;
}

function isLeaseExpired(lockExpiresAt: string | null, now: number): boolean {
  return lockExpiresAt === null || new Date(lockExpiresAt).getTime() <= now;
}

export type ClaimStepOutcome = { outcome: "claimed"; job: AutomationJob; claimToken: string } | { outcome: "already_claimed"; job: AutomationJob };

// (§6 동시성, §7 fencing) Claims the SEAT_FOUND -> PURCHASE_CLICKING ->
// RESERVING critical section for exactly one caller. A second concurrent
// caller against the same job either sees "already_claimed" (lease still
// live) or, once the lease has expired (the first Worker crashed or
// stalled), reclaims it with a brand-new token -- mirrors
// lib/watch/store.ts's claimNotification()/completeNotificationClaim()
// exactly, applied to job-step ownership instead of a notification row.
export function claimJobStep(id: string, userId: string): ClaimStepOutcome {
  const job = getJob(id, userId);
  const now = Date.now();

  if (job.status === "SEAT_FOUND") {
    const claimToken = generateClaimToken();
    const updated = transitionJob(id, userId, "PURCHASE_CLICKING", "구매 클릭을 위해 작업을 선점했습니다.");
    const locked: AutomationJob = { ...updated, stepClaimToken: claimToken, stepLockExpiresAt: new Date(now + getStepLeaseMs()).toISOString() };
    jobs.set(id, locked);
    return { outcome: "claimed", job: locked, claimToken };
  }

  if (job.status === "PURCHASE_CLICKING" || job.status === "RESERVING") {
    if (!isLeaseExpired(job.stepLockExpiresAt, now)) {
      return { outcome: "already_claimed", job };
    }
    // Lease expired -- another Worker (or this same one, on a later retry)
    // reclaims with a new token. The stale token a crashed Worker might
    // still be holding can never match this new one.
    const claimToken = generateClaimToken();
    const reclaimed: AutomationJob = { ...job, stepClaimToken: claimToken, stepLockExpiresAt: new Date(now + getStepLeaseMs()).toISOString(), updatedAt: new Date(now).toISOString() };
    jobs.set(id, reclaimed);
    return { outcome: "claimed", job: reclaimed, claimToken };
  }

  return { outcome: "already_claimed", job };
}

export type CompleteStepResult =
  | { applied: true; job: AutomationJob }
  | { applied: false; reason: "stale_claim" | "not_claimed"; job: AutomationJob | null };

// Only applies when `claimToken` matches the job's *current* stepClaimToken
// -- a stale Worker's late completion (its token no longer matches because
// another Worker already reclaimed the step) is rejected without touching
// the stored row at all (§7: "오래된 Worker의 완료 응답은 fencing token으로
// 차단한다"). `to`/`patch` describe the transition to apply on success;
// stepClaimToken/stepLockExpiresAt are always cleared, applied or not
// mattering only for whether the rest of the row changes.
export function completeJobStep(id: string, userId: string, claimToken: string, to: JobStatus, reason: string, patch: TransitionPatch = {}): CompleteStepResult {
  let job: AutomationJob;
  try {
    job = getJob(id, userId);
  } catch {
    return { applied: false, reason: "not_claimed", job: null };
  }

  if (job.stepClaimToken !== claimToken || (job.status !== "PURCHASE_CLICKING" && job.status !== "RESERVING")) {
    return { applied: false, reason: "stale_claim", job };
  }

  assertTransition(job.status, to);
  const now = new Date().toISOString();
  const updated: AutomationJob = {
    ...job,
    ...patch,
    status: to,
    stepClaimToken: null,
    stepLockExpiresAt: null,
    updatedAt: now,
    history: [...job.history, { at: now, from: job.status, to, reason }],
  };
  jobs.set(id, updated);
  return { applied: true, job: updated };
}

// Advances mid-claim from PURCHASE_CLICKING to RESERVING without releasing
// the claim (the same Worker keeps the same token through both steps) --
// used by worker.ts between a successful clickPurchase() and the reserve()
// attempt that follows it in the same tick.
export function advanceClaimedStep(id: string, userId: string, claimToken: string, to: JobStatus, reason: string, patch: TransitionPatch = {}): CompleteStepResult {
  const job = getJob(id, userId);
  if (job.stepClaimToken !== claimToken) {
    return { applied: false, reason: "stale_claim", job };
  }
  assertTransition(job.status, to);
  const now = new Date().toISOString();
  const updated: AutomationJob = { ...job, ...patch, status: to, updatedAt: now, history: [...job.history, { at: now, from: job.status, to, reason }] };
  jobs.set(id, updated);
  return { applied: true, job: updated };
}

// "다시 감시" (§5 UI) -- only ever valid from PAYMENT_EXPIRED (see
// state-machine.ts's comment on that one non-terminal exception). Starts a
// new watchCycle and clears every found/click/reservation field so the next
// tick begins a genuinely fresh search, never carrying over the previous
// cycle's (now-lost) seat.
export function resumeWatchingAfterPaymentExpired(id: string, userId: string): AutomationJob {
  const job = getJob(id, userId);
  assertTransition(job.status, "WATCHING");
  const now = new Date().toISOString();
  const updated: AutomationJob = {
    ...job,
    status: "WATCHING",
    watchCycle: job.watchCycle + 1,
    seatFoundAt: null,
    purchaseClickedAt: null,
    reservedAt: null,
    heldCandidateId: null,
    reservationNumber: null,
    paymentDeadline: null,
    definitiveSoldOutCandidateIds: [],
    stepClaimToken: null,
    stepLockExpiresAt: null,
    updatedAt: now,
    history: [...job.history, { at: now, from: job.status, to: "WATCHING", reason: "다시 감시(새 watchCycle)" }],
  };
  jobs.set(id, updated);
  return updated;
}

// Patches notifiedForCycle without any status transition (§6: "알림도 한
// watch cycle당 한 번만 전송된다") -- deliberately not routed through
// transitionJob(), since assertTransition() always rejects a from===to
// no-op and a successful reservation must not need a fake self-transition
// just to record that its notification went out.
export function markNotified(id: string, userId: string, cycle: number): AutomationJob {
  const job = getJob(id, userId);
  const updated: AutomationJob = { ...job, notifiedForCycle: cycle, updatedAt: new Date().toISOString() };
  jobs.set(id, updated);
  return updated;
}

// Records that `candidateId` is definitively sold out (no cancellation will
// ever reopen it, per the mock site) without moving the job's status --
// worker.ts checks the returned job's definitiveSoldOutCandidateIds against
// its full candidate list to decide whether every candidate has given up,
// at which point (and only then) the whole job retires to SOLD_OUT.
export function markCandidateDefinitiveSoldOut(id: string, userId: string, candidateId: string): AutomationJob {
  const job = getJob(id, userId);
  if (job.definitiveSoldOutCandidateIds.includes(candidateId)) return job;
  const updated: AutomationJob = {
    ...job,
    definitiveSoldOutCandidateIds: [...job.definitiveSoldOutCandidateIds, candidateId],
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, updated);
  return updated;
}

export function cancelJob(id: string, userId: string, reason = "사용자 취소"): AutomationJob {
  return transitionJob(id, userId, "CANCELLED", reason);
}

// "작업 삭제"(§5 UI) -- the API boundary (app/api/automation-jobs/[id]/
// route.ts) only ever calls this once isTerminalStatus(job.status) is true,
// so a running job can never be deleted out from under the Worker.
export function deleteJob(id: string, userId: string): void {
  getJob(id, userId); // throws NOT_FOUND if missing/not owned
  jobs.delete(id);
}

export function __resetJobStoreForTests(): void {
  jobs.clear();
}
