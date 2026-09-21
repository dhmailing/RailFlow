import "server-only";

import { dispatchNotification } from "@/lib/watch/notification/dispatch";
import { getSeatAvailabilityProvider } from "@/lib/watch/seat-provider";
import { isSeatWatchJobsEnabled } from "@/lib/watch/feature-flags";
import * as queue from "@/lib/watch/queue";
import { hasExpired, isTerminalStatus } from "@/lib/watch/state-machine";
import { getDevice, getWatchJob, recordAttempt, transitionWatchJob } from "@/lib/watch/store";
import { WatchError, type WatchJob } from "@/lib/watch/types";

const locksByJobId = new Set<string>();

// ENABLE_SEAT_WATCH_JOBS kill switch: flipping it off stops every job from
// advancing anywhere, immediately, without touching individual jobs. Same
// pattern as v0.4's worker.ts.
function assertJobsEnabled(): void {
  if (!isSeatWatchJobsEnabled()) {
    throw new WatchError("JOBS_DISABLED", "취소표 감시 작업이 비활성화되어 있습니다 (ENABLE_SEAT_WATCH_JOBS=false).");
  }
}

async function notifyAll(job: WatchJob, eventType: "seat_found" | "watch_expired", candidateId: string | null): Promise<void> {
  for (const method of job.notificationMethods) {
    let device;
    try {
      device = getDevice(method.deviceId, job.userId);
    } catch {
      continue; // a device removed after the job was created; skip rather than crash the tick
    }
    const title = eventType === "seat_found" ? "좌석이 발생했습니다" : "감시가 종료됐습니다";
    const body =
      eventType === "seat_found"
        ? `${job.departure} → ${job.arrival} · ${job.date} 열차의 좌석이 감지됐습니다. RailFlow에서 확인하고 코레일+에서 예매를 완료해주세요.`
        : `${job.departure} → ${job.arrival} · ${job.date} 감시가 종료 시각을 지나 만료됐습니다.`;
    // §6 검토사항: 멱등키에 channel+deviceId+watchCycle을 포함시켜, 같은
    // 이벤트라도 채널·기기마다 각자 한 번씩 알림을 받게 하고("다시 감시" 이후
    // 새 세대에서는 같은 후보라도 새 알림이 나가게) 한다. 오직 같은
    // 채널·같은 기기·같은 세대의 완전한 중복만 걸러진다.
    await dispatchNotification({
      userId: job.userId,
      watchJobId: job.id,
      candidateId,
      channel: method.channel,
      deviceId: device.id,
      watchCycle: job.watchCycle,
      eventType,
      idempotencyKey: `${job.id}:${candidateId ?? "job"}:${eventType}:${method.channel}:${device.id}:${job.watchCycle}`,
      destination: device.token,
      deviceVerified: device.verified,
      title,
      body,
    });
  }
}

async function runStep(jobId: string, userId: string): Promise<WatchJob> {
  const job = getWatchJob(jobId, userId);

  if (isTerminalStatus(job.status)) {
    return job;
  }

  if (hasExpired(job)) {
    const expired = transitionWatchJob(jobId, userId, "EXPIRED", "감시 종료시간(watchUntil)이 지나 자동으로 만료되었습니다.");
    await notifyAll(expired, "watch_expired", null);
    return expired;
  }

  const provider = getSeatAvailabilityProvider();

  if (job.status === "REGISTERED") {
    return transitionWatchJob(jobId, userId, "WATCHING", "감시를 시작합니다.", {
      seatProvider: provider.name,
      simulation: provider.name === "mock",
    });
  }

  if (job.status === "PROVIDER_UNAVAILABLE") {
    if (provider.name === "mock") {
      return transitionWatchJob(jobId, userId, "WATCHING", "Seat Availability Provider가 다시 연결되어 감시를 재개합니다.", {
        seatProvider: "mock",
        simulation: true,
      });
    }
    return job; // still unavailable -- no-op, no history spam every tick
  }

  if (job.status === "RATE_LIMITED") {
    return transitionWatchJob(jobId, userId, "WATCHING", "다시 확인합니다.");
  }

  if (job.status === "WATCHING") {
    if (provider.name === "unavailable") {
      return transitionWatchJob(jobId, userId, "PROVIDER_UNAVAILABLE", "공식 좌석정보 Provider가 아직 연결되지 않았습니다.", {
        seatProvider: "unavailable",
        simulation: false,
      });
    }

    let results;
    try {
      results = await provider.checkSeats(job);
    } catch (error) {
      if (!(error instanceof WatchError)) throw error;
      return recordAttempt(jobId, userId, { code: error.code, message: error.message });
    }

    const found = results.find((result) => result.available === true);
    if (!found) {
      return recordAttempt(jobId, userId, null);
    }
    recordAttempt(jobId, userId, null);

    const seatFound = transitionWatchJob(jobId, userId, "SEAT_FOUND", `${found.candidateId} 후보 열차의 좌석이 감지되었습니다.`, {
      foundCandidateId: found.candidateId,
      foundAt: found.checkedAt,
    });
    await notifyAll(seatFound, "seat_found", found.candidateId);
    return seatFound;
  }

  return job;
}

export function enqueueStep(jobId: string, userId: string, idempotencyKey: string): "queued" | "duplicate" {
  return queue.enqueue({ jobId, userId, idempotencyKey });
}

export async function drainOnce(): Promise<WatchJob | null> {
  assertJobsEnabled();
  const message = queue.dequeue();
  if (!message) return null;

  if (locksByJobId.has(message.jobId)) {
    return getWatchJob(message.jobId, message.userId);
  }
  locksByJobId.add(message.jobId);
  try {
    return await runStep(message.jobId, message.userId);
  } finally {
    locksByJobId.delete(message.jobId);
  }
}

export async function runJobOnce(jobId: string, userId: string, idempotencyKey: string): Promise<WatchJob> {
  assertJobsEnabled();
  const outcome = enqueueStep(jobId, userId, idempotencyKey);
  if (outcome === "duplicate") {
    return getWatchJob(jobId, userId);
  }

  const maxDrains = queue.queueSize();
  for (let i = 0; i < maxDrains; i += 1) {
    const processed = await drainOnce();
    if (processed && processed.id === jobId) return processed;
  }
  return getWatchJob(jobId, userId);
}

// User-triggered actions (not Worker ticks): the "예매 완료" and "다시 감시"
// buttons from §4's "좌석 발생" screen. Both are naturally idempotent via
// the state machine -- a second call fails with INVALID_TRANSITION rather
// than silently repeating (e.g. double-counting a completed booking).
export function confirmBooking(jobId: string, userId: string): WatchJob {
  return transitionWatchJob(jobId, userId, "COMPLETED", "사용자가 코레일+ 예매 완료를 직접 확인했습니다.");
}

export function resumeWatching(jobId: string, userId: string): WatchJob {
  const job = getWatchJob(jobId, userId);
  // §6 검토사항: 세대 카운터를 증가시켜, 재감시 이후 같은 후보가 다시
  // 발견됐을 때 이전 세대의 멱등키와 겹치지 않고 새 알림이 나가게 한다.
  return transitionWatchJob(jobId, userId, "WATCHING", "예매가 완료되지 않아 다시 감시를 시작합니다.", {
    watchCycle: job.watchCycle + 1,
  });
}
