import "server-only";

import { createInMemoryNotificationAdapter } from "@/lib/watch/notification/adapters";

import { isSeatAutomationJobsEnabled } from "@/lib/automation/feature-flags";
import * as jobStore from "@/lib/automation/job-store";
import { getSeatAutomationProvider } from "@/lib/automation/provider";
import * as queue from "@/lib/automation/queue";
import { hasExpired, hasPaymentExpired, isTerminalStatus } from "@/lib/automation/state-machine";
import { AutomationError, type AutomationJob } from "@/lib/automation/types";

// One job is ever processed at a time in this process -- mirrors
// lib/reservation/worker.ts's in-process lock exactly (a real queue would
// use visibility timeouts instead). This is on top of, not instead of, the
// stepClaimToken CAS in job-store.ts: this lock stops two *ticks* of the
// same job from interleaving inside one Node process, while the claim token
// is what stays correct even across separate processes/instances.
const locksByJobId = new Set<string>();

// (§4) 이메일/텔레그램/FCM/WebPush 실제 발송 불가 -- lib/watch/notification/
// adapters.ts의 InMemory Adapter를 그대로 재사용한다. 실제 서비스 키 연동은
// 이번 PR의 범위가 아니다(v0.5와 동일한 이유).
const successAdapter = createInMemoryNotificationAdapter("email");

function assertJobsEnabled(): void {
  if (!isSeatAutomationJobsEnabled()) {
    throw new AutomationError("JOBS_DISABLED", "자동화 작업이 비활성화되어 있습니다 (ENABLE_SEAT_AUTOMATION_JOBS=false).");
  }
}

function nextCheckAt(job: Pick<AutomationJob, "intervalSeconds">): string {
  return new Date(Date.now() + job.intervalSeconds * 1000).toISOString();
}

// §6: "알림도 한 watch cycle당 한 번만 전송된다" -- notifiedForCycle guards
// against a retried tick re-sending the same success notification.
async function maybeNotifySuccess(job: AutomationJob, userId: string): Promise<AutomationJob> {
  if (job.notifiedForCycle === job.watchCycle) return job;
  try {
    await successAdapter.send({
      userId,
      watchJobId: job.id,
      candidateId: job.heldCandidateId,
      channel: "email",
      eventType: "seat_found",
      idempotencyKey: `${job.id}:${job.watchCycle}:success`,
      destination: "demo@railflow.internal",
      title: "예약 성공",
      body: `${job.departure} → ${job.arrival} · 예약번호 ${job.reservationNumber}`,
    });
  } catch {
    // NotConfigured 등으로 실패해도 작업 상태(HELD/PAYMENT_PENDING)는 절대
    // 되돌리지 않는다 -- 알림은 부가 기능이다.
  }
  return jobStore.markNotified(job.id, userId, job.watchCycle);
}

async function runStep(jobId: string, userId: string): Promise<AutomationJob> {
  const job = jobStore.getJob(jobId, userId);
  if (isTerminalStatus(job.status)) return job;

  if (job.status === "PAYMENT_PENDING") {
    if (hasPaymentExpired(job)) {
      return jobStore.transitionJob(jobId, userId, "PAYMENT_EXPIRED", "결제기한이 지나 자동으로 만료되었습니다.");
    }
    return job; // 결제 완료는 사용자의 명시적 확인(별도 API)로만 이뤄진다 -- 자동 추정 금지.
  }

  if (hasExpired(job)) {
    return jobStore.transitionJob(jobId, userId, "EXPIRED", "감시 유효기간(watchUntil)이 지나 자동으로 만료되었습니다.");
  }

  const provider = await getSeatAutomationProvider();
  if (provider.name !== job.provider && job.status !== "PROVIDER_CHANGED") {
    return jobStore.transitionJob(jobId, userId, "PROVIDER_CHANGED", `Provider가 ${job.provider}에서 ${provider.name}(으)로 변경됐습니다.`);
  }
  if (job.status === "PROVIDER_CHANGED") return job;

  if (job.status === "SCHEDULED") {
    return jobStore.transitionJob(jobId, userId, "WATCHING", "감시를 시작합니다.");
  }
  if (job.status === "RATE_LIMITED" || job.status === "AUTH_REQUIRED") {
    return jobStore.transitionJob(jobId, userId, "WATCHING", "다시 확인합니다.");
  }
  if (job.status === "HELD") {
    return jobStore.transitionJob(jobId, userId, "PAYMENT_PENDING", "좌석 확보 완료, 결제 대기로 전환합니다.");
  }

  if (job.status !== "WATCHING") return job;

  const checking = jobStore.transitionJob(jobId, userId, "CHECKING_AVAILABILITY", "좌석 확인 중입니다.");
  const candidate = checking.candidates[checking.attempts % checking.candidates.length];

  let availability;
  try {
    availability = await provider.searchAvailability({ job: checking, candidate });
  } catch (error) {
    jobStore.transitionJob(jobId, userId, "WATCHING", "확인 실패, 다시 대기합니다.");
    if (!(error instanceof AutomationError)) throw error;
    return jobStore.recordAttempt(jobId, userId, { code: error.code, message: error.message }, nextCheckAt(checking));
  }

  if (!availability.available) {
    let after = jobStore.transitionJob(
      jobId,
      userId,
      "WATCHING",
      availability.definitiveSoldOut ? `${candidate.id} 후보는 매진(재판매 없음)입니다.` : `${candidate.id} 후보에 아직 좌석이 없습니다.`,
    );
    if (availability.definitiveSoldOut) {
      after = jobStore.markCandidateDefinitiveSoldOut(jobId, userId, candidate.id);
    }
    const updated = jobStore.recordAttempt(jobId, userId, null, nextCheckAt(after));
    if (updated.definitiveSoldOutCandidateIds.length >= updated.candidates.length) {
      return jobStore.transitionJob(jobId, userId, "SOLD_OUT", "선택한 모든 후보 열차가 매진(재판매 없음)되었습니다.");
    }
    return updated;
  }

  jobStore.transitionJob(jobId, userId, "SEAT_FOUND", `${availability.candidateId} 후보에서 좌석을 발견했습니다.`, {
    seatFoundAt: availability.checkedAt,
  });

  // (§6 동시성) 원자적 선점 -- claim에 실패하면(다른 Worker가 이미 처리
  // 중이면) 이번 tick은 아무것도 더 하지 않는다.
  const claim = jobStore.claimJobStep(jobId, userId);
  if (claim.outcome !== "claimed") {
    return claim.job;
  }
  const { claimToken } = claim;

  try {
    const clickResult = await provider.clickPurchase({ job: claim.job, candidateId: availability.candidateId });
    const clicked = jobStore.advanceClaimedStep(jobId, userId, claimToken, "RESERVING", "구매 클릭 완료, 예약을 요청합니다.", {
      purchaseClickedAt: clickResult.clickedAt,
    });
    if (!clicked.applied) {
      return clicked.job ?? jobStore.getJob(jobId, userId);
    }

    // (§6 동시성) idempotencyKey는 (jobId, watchCycle, candidateId)로
    // 스코프된다 -- 이 tick이 재시도되어도, 그리고 "다시 감시"로 새
    // watchCycle이 시작된 뒤에도 서로 다른 예약 시도로 구분된다.
    const idempotencyKey = `${jobId}:${claim.job.watchCycle}:${availability.candidateId}`;

    try {
      const reservation = await provider.reserve({ job: clicked.job, candidateId: availability.candidateId, idempotencyKey });
      const held = jobStore.completeJobStep(jobId, userId, claimToken, "HELD", "좌석을 확보했습니다.", {
        reservedAt: new Date().toISOString(),
        heldCandidateId: availability.candidateId,
        reservationNumber: reservation.reservationNumber,
        paymentDeadline: reservation.paymentDeadline,
        reservedForCycle: clicked.job.watchCycle,
      });
      if (!held.applied) {
        return held.job ?? jobStore.getJob(jobId, userId);
      }
      // §3-B/§6: 예약 성공 즉시 다른 후보 감시는 자동 중단된다 -- 이 job은
      // 더 이상 WATCHING이 아니므로(HELD), 다음 tick에서 이 함수의
      // `if (job.status !== "WATCHING") return job;` 가드가 다른 후보를
      // 절대 확인하지 않게 막는다. 별도의 "다른 후보 중단" 로직이 필요
      // 없다 -- job 자체가 단일 상태 기계이기 때문이다.
      return await maybeNotifySuccess(held.job, userId);
    } catch (error) {
      const code = error instanceof AutomationError ? error.code : "RESERVE_FAILED";
      const message = error instanceof Error ? error.message : "예약 요청 중 오류가 발생했습니다.";
      const released = jobStore.completeJobStep(jobId, userId, claimToken, "WATCHING", "예약 실패로 다시 감시 상태로 돌아갑니다.", {
        lastError: { code, message },
      });
      return released.applied ? released.job : (released.job ?? jobStore.getJob(jobId, userId));
    }
  } catch (error) {
    const code = error instanceof AutomationError ? error.code : "PURCHASE_CLICK_FAILED";
    const message = error instanceof Error ? error.message : "구매 클릭 중 오류가 발생했습니다.";
    const failed = jobStore.completeJobStep(jobId, userId, claimToken, "FAILED", "구매 클릭 실패.", { lastError: { code, message } });
    return failed.applied ? failed.job : (failed.job ?? jobStore.getJob(jobId, userId));
  }
}

export function enqueueStep(jobId: string, userId: string, idempotencyKey: string): "queued" | "duplicate" {
  return queue.enqueue({ jobId, userId, idempotencyKey });
}

export async function drainOnce(): Promise<AutomationJob | null> {
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

export async function runJobOnce(jobId: string, userId: string, idempotencyKey: string): Promise<AutomationJob> {
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
