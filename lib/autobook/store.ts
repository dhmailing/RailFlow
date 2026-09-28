import "server-only";

import {
  AutobookError,
  type AutobookJob,
  type AutobookJobStatus,
  type AutobookNotification,
} from "@/lib/autobook/types";

// 저장소 인터페이스.
//
// 여기 있는 메서드들의 계약이 "동시에 도는 Worker 여러 개가 같은 작업을
// 두 번 예약하지 않는다"를 보장한다. 메모리 구현과 Postgres 구현이 같은
// 계약을 지켜야 한다.
//
// 핵심은 `claimNext` 와 `fencingToken` 이다:
//  - claimNext 는 원자적이어야 한다. 두 Worker가 동시에 불러도 한 쪽만
//    작업을 받는다.
//  - 받은 Worker 는 단조 증가하는 fencingToken 을 갖는다. 되돌릴 수 없는
//    동작(예약 요청) 직전에 자기 토큰이 아직 최신인지 확인한다.
//  - 잠깐 멈췄다 깨어난 오래된 Worker 는 토큰이 뒤처져 있으므로 아무 것도
//    쓰지 못한다(STALE_CLAIM).

export interface AutobookStore {
  createJob(job: AutobookJob): Promise<AutobookJob>;
  getJob(id: string): Promise<AutobookJob | null>;
  listJobsByUser(userId: string): Promise<AutobookJob[]>;

  /** 같은 사용자·날짜·구간·인원에 이미 활성 작업이 있는지. */
  findActiveByDedupeKey(userId: string, dedupeKey: string): Promise<AutobookJob | null>;

  /**
   * 처리할 작업 하나를 원자적으로 가져온다.
   * 이미 살아있는 claim 이 있는 작업은 돌려주지 않는다.
   */
  claimNext(input: { workerId: string; now: string; leaseMs: number }): Promise<AutobookJob | null>;

  /**
   * claim 을 연장한다. 오래 걸리는 처리 중에 다른 Worker가 뺏어가지 않게 한다.
   * 토큰이 뒤처졌으면 STALE_CLAIM 을 던진다.
   */
  renewClaim(input: { jobId: string; workerId: string; fencingToken: number; leaseMs: number }): Promise<void>;

  /**
   * 상태를 쓴다. **fencingToken 이 최신이 아니면 거부한다.**
   * 이것이 stale worker 를 막는 지점이다.
   */
  updateJob(input: {
    jobId: string;
    workerId: string;
    fencingToken: number;
    patch: Partial<Omit<AutobookJob, "id" | "userId" | "createdAt">>;
  }): Promise<AutobookJob>;

  /** claim 을 놓는다(토큰은 유지된다 -- 다음 claim 은 더 큰 토큰을 받는다). */
  releaseClaim(input: { jobId: string; workerId: string; fencingToken: number }): Promise<void>;

  /** 사용자 조작(취소 등). Worker claim 과 무관하게 상태를 바꾼다. */
  updateByUser(input: { jobId: string; userId: string; status: AutobookJobStatus; statusDetail?: string | null }): Promise<AutobookJob>;

  // --- 알림 Outbox ---------------------------------------------------------

  /** 같은 idempotencyKey 로 두 번 넣어도 하나만 남는다. */
  enqueueNotification(notification: AutobookNotification): Promise<AutobookNotification | null>;
  /** 보낼 알림 하나를 원자적으로 집는다. */
  claimNotification(input: { workerId: string; fencingToken: number; now: string }): Promise<AutobookNotification | null>;
  markNotificationSent(input: { id: string; workerId: string; fencingToken: number }): Promise<void>;
  markNotificationFailed(input: { id: string; workerId: string; fencingToken: number }): Promise<void>;
  listNotifications(jobId: string): Promise<AutobookNotification[]>;
}

/** 저장소를 쓸 수 없을 때 모든 호출이 같은 방식으로 실패하게 한다. */
export function unavailableStore(reason: string): AutobookStore {
  const fail = (): never => {
    throw new AutobookError("STORE_UNAVAILABLE", reason);
  };
  return {
    createJob: fail,
    getJob: fail,
    listJobsByUser: fail,
    findActiveByDedupeKey: fail,
    claimNext: fail,
    renewClaim: fail,
    updateJob: fail,
    releaseClaim: fail,
    updateByUser: fail,
    enqueueNotification: fail,
    claimNotification: fail,
    markNotificationSent: fail,
    markNotificationFailed: fail,
    listNotifications: fail,
  } as unknown as AutobookStore;
}
