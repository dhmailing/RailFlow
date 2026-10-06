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
//
// **중복 전송에 대해 실제로 보장하는 수준(T8).** 과장하지 않고 적는다.
//
//  1. 막을 수 있는 것: 전송은 성공했는데 `markNotificationSent` 기록이
//     실패하는 창. 기록 실패를 전송 실패로 집계하지 않고, claim 을 놓지
//     않으며, 기록 재시도는 RECORD_ATTEMPTS 회로 제한한다. 끝까지 실패하면
//     `sentUnrecorded` 로 보고하고 **다시 보내지 않는다.**
//  2. 막을 수 없는 것: 채널이 예외를 던졌지만 실제로는 전달된 경우.
//     Outbox 는 그것을 알 방법이 없으므로 재시도하고, 사용자는 알림을 두 번
//     받을 수 있다. 이 경우의 방어선은 **채널의 멱등 처리**다. 그래서
//     `send()` 에 멱등키를 명시적으로 넘기고, 채널이 같은 키를 두 번
//     전달하지 않을 책임을 계약으로 적어 둔다.
//  3. 남아 있는 한계: 알림 claim 에는 lease·만료가 없다(lib/autobook/
//     memory-store.ts, postgres-store.ts). 그래서 1 의 "claim 을 놓지 않는다"가
//     재전송을 막아 주지만, Worker 가 죽으면 그 알림은 다시 집히지 않는다.
//     나중에 알림 claim 에 만료 재획득을 넣으면 중복 전송 창이 되살아나므로,
//     그때는 2 의 채널 멱등 처리가 유일한 방어선이 된다.

/**
 * 채널이 중복을 스스로 걸러낼 수 있도록 멱등키를 명시적으로 넘긴다.
 * `notification.idempotencyKey` 와 같은 값이지만, 계약을 타입에 드러내서
 * 채널 구현이 "몰랐다"고 할 수 없게 한다.
 */
export type NotificationSendContext = {
  readonly idempotencyKey: string;
};

export type NotificationChannel = {
  readonly name: string;
  /**
   * **구현 책임:** 같은 `context.idempotencyKey` 로 두 번 불리면 두 번째는
   * 전달하지 말아야 한다. Outbox 는 "보냈는지 확실하지 않은" 경우를 재시도
   * 하므로, 최종 중복 방지는 채널 쪽에서만 가능하다.
   */
  send(notification: AutobookNotification, context: NotificationSendContext): Promise<void>;
};

/** 개발·테스트용. 실제로 아무 데도 보내지 않고 기록만 한다. */
export function createInMemoryChannel(): NotificationChannel & {
  sent: AutobookNotification[];
  suppressed: AutobookNotification[];
} {
  const sent: AutobookNotification[] = [];
  const suppressed: AutobookNotification[] = [];
  const delivered = new Set<string>();
  return {
    name: "memory",
    sent,
    suppressed,
    async send(notification, context) {
      // 채널 계약대로 멱등키로 중복을 억제한다.
      const key = context?.idempotencyKey ?? notification.idempotencyKey;
      if (delivered.has(key)) {
        suppressed.push(notification);
        return;
      }
      delivered.add(key);
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

/** 전송 뒤 기록(markNotificationSent) 재시도 상한. 무제한 재시도는 하지 않는다. */
export const RECORD_ATTEMPTS = 3;

export type FlushOutboxResult = {
  /** 보냈고 기록까지 끝난 건수. */
  sent: number;
  /** 보내지 못해 다음 차례에 다시 시도할 건수. */
  failed: number;
  /** 보냈지만 기록을 끝내지 못한 건수. **다시 보내지 않는다.** */
  sentUnrecorded: number;
};

/**
 * Outbox 를 한 번 비운다.
 *
 * `channel.send` 와 `markNotificationSent` 를 **별도 try 로 분리한다.** 전송
 * 실패와 기록 실패는 성질이 다르다.
 *  - 전송 실패: 보내지 못했다. claim 을 놓아 다음 차례에 다시 시도한다.
 *  - 기록 실패: 이미 보냈다. 다시 보내면 중복이므로 재시도는 기록에 대해서만
 *    하고(RECORD_ATTEMPTS 회), 그래도 실패하면 claim 을 쥔 채 포기해
 *    `sentUnrecorded` 로 보고한다.
 */
export async function flushOutboxOnce(input: {
  store: AutobookStore;
  channel: NotificationChannel;
  workerId: string;
  fencingToken: number;
}): Promise<FlushOutboxResult> {
  const { store, channel, workerId, fencingToken } = input;
  const notification = await store.claimNotification({
    workerId,
    fencingToken,
    now: new Date().toISOString(),
  });
  if (!notification) return { sent: 0, failed: 0, sentUnrecorded: 0 };

  // --- 1단계: 전송 ---------------------------------------------------------
  try {
    await channel.send(notification, { idempotencyKey: notification.idempotencyKey });
  } catch {
    // 보내지 못했다(또는 보냈는지 알 수 없다). 다음 차례에 다시 시도한다.
    // 실제로는 전달됐을 수 있으므로 중복 방지는 채널의 멱등 처리에 맡긴다.
    await store.markNotificationFailed({ id: notification.id, workerId, fencingToken });
    return { sent: 0, failed: 1, sentUnrecorded: 0 };
  }

  // --- 2단계: 기록 ---------------------------------------------------------
  // 여기부터는 **이미 보낸 상태다.** 어떤 경로로도 재전송으로 되돌아가지 않는다.
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    try {
      await store.markNotificationSent({ id: notification.id, workerId, fencingToken });
      return { sent: 1, failed: 0, sentUnrecorded: 0 };
    } catch {
      // 지연 없이 즉시 재시도한다. 긴 백오프는 Worker 한 턴을 붙잡는다.
    }
  }

  // 기록을 끝내지 못했다. markNotificationFailed 를 부르지 않는다 -- 그것은
  // claim 을 놓아 다음 차례에 같은 알림을 다시 보내게 만든다(중복 전송).
  return { sent: 0, failed: 0, sentUnrecorded: 1 };
}
