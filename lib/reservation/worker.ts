import "server-only";

import { isReservationJobsEnabled } from "@/lib/reservation/feature-flags";
import * as jobStore from "@/lib/reservation/job-store";
import { getReservationProvider } from "@/lib/reservation/provider";
import * as queue from "@/lib/reservation/queue";
import { assertNotExpired } from "@/lib/reservation/state-machine";
import { ReservationProviderError, type ReservationJob } from "@/lib/reservation/types";

// One job is ever processed at a time in this process, even if two requests
// race to drain the queue for it -- this is the "process restart / duplicate
// consumption / concurrent execution" lock the v0.4 spec calls for. A real
// queue (SQS/BullMQ/etc.) would provide this via visibility timeouts instead.
const locksByJobId = new Set<string>();

// This is the ENABLE_RESERVATION_JOBS kill switch: flipping it off stops every
// job from advancing anywhere, immediately, without touching individual jobs.
function assertJobsEnabled(): void {
  if (!isReservationJobsEnabled()) {
    throw new ReservationProviderError(
      "JOBS_DISABLED",
      "예약 작업이 비활성화되어 있습니다 (ENABLE_RESERVATION_JOBS=false).",
    );
  }
}

async function runStep(jobId: string, userId: string): Promise<ReservationJob> {
  const job = jobStore.getJob(jobId, userId);
  assertNotExpired(job);

  if (job.status === "COMPLETED" || job.status === "CANCELLED" || job.status === "EXPIRED" || job.status === "FAILED" || job.status === "PAYMENT_PENDING") {
    return job;
  }

  const provider = getReservationProvider();
  if (provider.name !== job.provider) {
    return jobStore.transitionJob(
      jobId,
      userId,
      "PROVIDER_CHANGED",
      `Provider가 ${job.provider}에서 ${provider.name}(으)로 변경됐습니다.`,
    );
  }

  if (job.status === "DRAFT") {
    return jobStore.transitionJob(jobId, userId, "SCHEDULED", "예약 작업이 대기열에 등록됐습니다.");
  }
  if (job.status === "SCHEDULED") {
    return jobStore.transitionJob(jobId, userId, "WATCHING", "좌석 확인을 시작합니다.");
  }
  if (job.status === "RATE_LIMITED" || job.status === "AUTH_REQUIRED") {
    return jobStore.transitionJob(jobId, userId, "WATCHING", "다시 확인합니다.");
  }
  if (job.status === "HELD") {
    return jobStore.transitionJob(jobId, userId, "PAYMENT_PENDING", "좌석 확보 완료, 결제 대기로 전환합니다.");
  }

  if (job.status === "WATCHING") {
    let availability;
    try {
      availability = await provider.checkAvailability(job);
    } catch (error) {
      if (!(error instanceof ReservationProviderError)) throw error;
      return jobStore.recordAttempt(jobId, userId, { code: error.code, message: error.message });
    }

    if (!availability.available) {
      return jobStore.recordAttempt(jobId, userId, null);
    }
    jobStore.recordAttempt(jobId, userId, null);

    const reserving = jobStore.transitionJob(
      jobId,
      userId,
      "RESERVING",
      `${availability.candidateId} 후보 열차의 좌석을 확인했습니다.`,
    );
    try {
      const reservation = await provider.reserve(reserving, availability.candidateId);
      return jobStore.transitionJob(jobId, userId, "HELD", "좌석을 확보했습니다.", {
        heldCandidateId: reservation.candidateId,
      });
    } catch (error) {
      if (!(error instanceof ReservationProviderError)) throw error;
      return jobStore.transitionJob(jobId, userId, "WATCHING", "예약 실패로 다시 확인 상태로 돌아갑니다.", {
        lastError: { code: error.code, message: error.message },
      });
    }
  }

  return job;
}

export function enqueueStep(jobId: string, userId: string, idempotencyKey: string): "queued" | "duplicate" {
  return queue.enqueue({ jobId, userId, idempotencyKey });
}

export async function drainOnce(): Promise<ReservationJob | null> {
  assertJobsEnabled();
  const message = queue.dequeue();
  if (!message) return null;

  if (locksByJobId.has(message.jobId)) {
    return jobStore.getJob(message.jobId, message.userId);
  }
  locksByJobId.add(message.jobId);
  try {
    return await runStep(message.jobId, message.userId);
  } finally {
    locksByJobId.delete(message.jobId);
  }
}

// Enqueues one step for `jobId` and drains the queue (in FIFO order, so other
// pending jobs are not starved) until that job's message has been processed,
// or the queue that existed at enqueue time is exhausted. A duplicate
// idempotencyKey short-circuits to the job's current state without re-running
// the provider call, which is what makes retries safe.
export async function runJobOnce(jobId: string, userId: string, idempotencyKey: string): Promise<ReservationJob> {
  assertJobsEnabled();
  const outcome = enqueueStep(jobId, userId, idempotencyKey);
  if (outcome === "duplicate") {
    return jobStore.getJob(jobId, userId);
  }

  const maxDrains = queue.queueSize();
  for (let i = 0; i < maxDrains; i += 1) {
    const processed = await drainOnce();
    if (processed && processed.id === jobId) return processed;
  }
  return jobStore.getJob(jobId, userId);
}
