import "server-only";

import type { AutobookStore } from "@/lib/autobook/store";
import {
  AutobookError,
  TERMINAL_STATUSES,
  type AutobookJob,
  type AutobookJobStatus,
  type AutobookNotification,
} from "@/lib/autobook/types";

// 개발·테스트 전용 인메모리 저장소.
//
// Node.js 는 단일 스레드이므로 이 파일 안의 동기 구간은 원자적이다.
// `claimNext` 와 `updateJob` 사이에 `await` 를 넣지 않는 것이 중요하다 --
// 그래야 "동시에 도는 Worker 10개" 테스트가 실제 경쟁을 재현한다.
//
// Postgres 구현은 같은 계약을 `SELECT ... FOR UPDATE SKIP LOCKED` 와
// `WHERE fencing_token = $n` 조건부 UPDATE 로 지켜야 한다
// (db/postgres/migrations/0002_autobook.sql 참고).

const jobs = new Map<string, AutobookJob>();
const notifications = new Map<string, AutobookNotification>();
/** 작업별 마지막 발급 토큰. 단조 증가를 보장한다. */
const lastToken = new Map<string, number>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isActive(status: AutobookJobStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/** Worker가 지금 집어도 되는 작업인지. */
function isClaimable(job: AutobookJob, now: string): boolean {
  if (!isActive(job.status)) return false;
  // 사용자의 조치를 기다리는 상태는 Worker가 건드리지 않는다.
  if (job.status === "RESERVATION_HELD" || job.status === "PAYMENT_PENDING") return false;
  if (job.nextCheckAt && job.nextCheckAt > now) return false;
  if (job.claim && job.claim.leaseExpiresAt > now) return false;
  return true;
}

function assertFresh(job: AutobookJob, workerId: string, fencingToken: number): void {
  if (!job.claim) {
    throw new AutobookError("STALE_CLAIM", "이 작업에 대한 claim 이 없습니다.");
  }
  if (job.claim.fencingToken !== fencingToken || job.claim.workerId !== workerId) {
    throw new AutobookError(
      "STALE_CLAIM",
      `더 최신 Worker가 이 작업을 맡고 있습니다(현재 토큰 ${job.claim.fencingToken}, 요청 토큰 ${fencingToken}).`,
    );
  }
}

export function createMemoryAutobookStore(): AutobookStore {
  return {
    async createJob(job) {
      if (jobs.has(job.id)) throw new AutobookError("DUPLICATE_JOB", "같은 id 의 작업이 이미 있습니다.");
      jobs.set(job.id, clone(job));
      return clone(job);
    },

    async getJob(id) {
      const job = jobs.get(id);
      return job ? clone(job) : null;
    },

    async listJobsByUser(userId) {
      return [...jobs.values()].filter((job) => job.userId === userId).map(clone);
    },

    async findActiveByDedupeKey(userId, dedupeKey) {
      const found = [...jobs.values()].find(
        (job) => job.userId === userId && job.dedupeKey === dedupeKey && isActive(job.status),
      );
      return found ? clone(found) : null;
    },

    async claimNext({ workerId, now, leaseMs }) {
      // 여기부터 return 까지 await 가 없다 = 원자적이다.
      for (const job of jobs.values()) {
        if (!isClaimable(job, now)) continue;
        const token = (lastToken.get(job.id) ?? 0) + 1;
        lastToken.set(job.id, token);
        job.claim = {
          workerId,
          fencingToken: token,
          claimedAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
        };
        job.updatedAt = now;
        return clone(job);
      }
      return null;
    },

    async renewClaim({ jobId, workerId, fencingToken, leaseMs }) {
      const job = jobs.get(jobId);
      if (!job) throw new AutobookError("NOT_FOUND", "작업을 찾을 수 없습니다.");
      assertFresh(job, workerId, fencingToken);
      job.claim!.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    },

    async updateJob({ jobId, workerId, fencingToken, patch }) {
      const job = jobs.get(jobId);
      if (!job) throw new AutobookError("NOT_FOUND", "작업을 찾을 수 없습니다.");
      // 오래된 Worker 가 뒤늦게 깨어나 쓰는 것을 여기서 막는다.
      assertFresh(job, workerId, fencingToken);
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      return clone(job);
    },

    async releaseClaim({ jobId, workerId, fencingToken }) {
      const job = jobs.get(jobId);
      if (!job) return;
      // 이미 다른 Worker 가 가져갔으면 남의 claim 을 지우지 않는다.
      if (job.claim?.fencingToken !== fencingToken || job.claim.workerId !== workerId) return;
      job.claim = null;
    },

    async updateByUser({ jobId, userId, status, statusDetail = null }) {
      const job = jobs.get(jobId);
      if (!job || job.userId !== userId) throw new AutobookError("NOT_FOUND", "작업을 찾을 수 없습니다.");
      job.status = status;
      job.statusDetail = statusDetail;
      job.updatedAt = new Date().toISOString();
      return clone(job);
    },

    async enqueueNotification(notification) {
      // 멱등키가 같으면 새로 넣지 않는다 -- 같은 사건에 알림이 두 번 가지 않게.
      for (const existing of notifications.values()) {
        if (existing.idempotencyKey === notification.idempotencyKey) return null;
      }
      notifications.set(notification.id, clone(notification));
      return clone(notification);
    },

    async claimNotification({ workerId, fencingToken, now }) {
      for (const notification of notifications.values()) {
        if (notification.sentAt) continue;
        if (notification.claimedBy) continue;
        notification.claimedBy = workerId;
        notification.claimedFencingToken = fencingToken;
        notification.createdAt = notification.createdAt || now;
        return clone(notification);
      }
      return null;
    },

    async markNotificationSent({ id, workerId, fencingToken }) {
      const notification = notifications.get(id);
      if (!notification) throw new AutobookError("NOT_FOUND", "알림을 찾을 수 없습니다.");
      if (notification.claimedBy !== workerId || notification.claimedFencingToken !== fencingToken) {
        throw new AutobookError("STALE_CLAIM", "이 알림은 다른 Worker가 맡고 있습니다.");
      }
      notification.sentAt = new Date().toISOString();
    },

    async markNotificationFailed({ id, workerId, fencingToken }) {
      const notification = notifications.get(id);
      if (!notification) throw new AutobookError("NOT_FOUND", "알림을 찾을 수 없습니다.");
      if (notification.claimedBy !== workerId || notification.claimedFencingToken !== fencingToken) {
        throw new AutobookError("STALE_CLAIM", "이 알림은 다른 Worker가 맡고 있습니다.");
      }
      notification.failedAttempts += 1;
      notification.claimedBy = null;
      notification.claimedFencingToken = null;
    },

    async listNotifications(jobId) {
      return [...notifications.values()].filter((item) => item.jobId === jobId).map(clone);
    },
  };
}

/** 테스트 전용. 프로세스 안의 모든 상태를 지운다. */
export function resetMemoryAutobookStore(): void {
  jobs.clear();
  notifications.clear();
  lastToken.clear();
}
