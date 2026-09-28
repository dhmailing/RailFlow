import "server-only";

import type { AutobookStore } from "@/lib/autobook/store";
import type { AutobookJob, AutobookNotification, AutobookNotificationKind } from "@/lib/autobook/types";

// 알림 Outbox.
//
// 알림을 "보내면서" 상태를 바꾸지 않는다. 상태 변경과 같은 트랜잭션에서
// Outbox 행을 남기고, 별도 단계가 그 행을 집어 보낸다. 그래야
//  - 상태는 바뀌었는데 알림이 안 가는 일
//  - 알림은 갔는데 상태가 안 바뀐 일
// 을 둘 다 막을 수 있다.
//
// 멱등키가 같은 알림은 두 번 들어가지 않는다. 좌석 확보 알림이 두 번
// 가는 것은 사용자에게 "예약이 두 건인가?"라는 혼란을 준다.

export type NotificationChannel = {
  readonly name: string;
  send(notification: AutobookNotification): Promise<void>;
};

/** 개발·테스트용. 실제로 아무 데도 보내지 않고 기록만 한다. */
export function createInMemoryChannel(): NotificationChannel & { sent: AutobookNotification[] } {
  const sent: AutobookNotification[] = [];
  return {
    name: "memory",
    sent,
    async send(notification) {
      sent.push(notification);
    },
  };
}

export function notificationIdempotencyKey(job: AutobookJob, kind: AutobookNotificationKind): string {
  // 작업 + 종류 + (좌석 확보의 경우) 예약 식별자. 같은 사건이면 같은 키다.
  const suffix = kind === "SEAT_HELD" && job.hold ? `:${job.hold.reservationRef}` : "";
  return `${job.id}:${kind}${suffix}`;
}

export function buildNotification(input: {
  job: AutobookJob;
  kind: AutobookNotificationKind;
  id: string;
}): AutobookNotification {
  const { job, kind, id } = input;
  return {
    id,
    jobId: job.id,
    userId: job.userId,
    kind,
    idempotencyKey: notificationIdempotencyKey(job, kind),
    // 알림 payload 에 자격증명·세션·예약번호 원문을 넣지 않는다.
    payload: {
      trainNumber: job.hold?.trainNumber ?? null,
      departAt: job.hold?.departAt ?? null,
      departure: job.condition.departure,
      arrival: job.condition.arrival,
      date: job.condition.date,
      paymentDueAt: job.hold?.paymentDueAt ?? null,
      simulation: job.simulation ? 1 : 0,
    },
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedFencingToken: null,
    sentAt: null,
    failedAttempts: 0,
  };
}

/**
 * Outbox 를 한 번 비운다. 집은 뒤 보내고, 성공해야 sent 로 표시한다.
 * 실패하면 claim 을 놓아 다음 차례에 다시 시도한다.
 */
export async function flushOutboxOnce(input: {
  store: AutobookStore;
  channel: NotificationChannel;
  workerId: string;
  fencingToken: number;
}): Promise<{ sent: number; failed: number }> {
  const { store, channel, workerId, fencingToken } = input;
  const notification = await store.claimNotification({
    workerId,
    fencingToken,
    now: new Date().toISOString(),
  });
  if (!notification) return { sent: 0, failed: 0 };

  try {
    await channel.send(notification);
    await store.markNotificationSent({ id: notification.id, workerId, fencingToken });
    return { sent: 1, failed: 0 };
  } catch {
    await store.markNotificationFailed({ id: notification.id, workerId, fencingToken });
    return { sent: 0, failed: 1 };
  }
}
