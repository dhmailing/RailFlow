import "server-only";

import { getNotificationAdapter } from "@/lib/watch/notification/get-adapter";
import { hasDeliveredNotification, recordNotificationDelivery } from "@/lib/watch/store";
import { WatchError, type NotificationChannel, type NotificationDelivery, type NotificationEventType } from "@/lib/watch/types";

export type DispatchNotificationInput = {
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  deviceId: string;
  watchCycle: number;
  eventType: NotificationEventType;
  idempotencyKey: string;
  destination: string;
  // §5 검토사항: 소유권이 확인되지 않은 수신처(기본값 email/telegram)에는
  // 실제 알림을 절대 보내지 않는다 -- 어댑터를 호출하기 전에 여기서 막는다.
  deviceVerified: boolean;
  title: string;
  body: string;
};

// 이전에 *성공(delivered)*한 알림과 같은 idempotencyKey면 어댑터를 다시
// 호출하지 않고 "skipped_duplicate"만 기록한다. *실패(failed)*했던 시도는
// 그렇지 않다 -- 다음 Worker tick에서 같은 키로 재시도할 수 있어야 한다.
// idempotencyKey는 channel+deviceId+watchCycle까지 포함하도록 호출자
// (lib/watch/worker.ts)가 구성하므로, 여러 채널·여러 기기가 각자 한 번씩
// 알림을 받고, 같은 채널·같은 기기·같은 이벤트의 완전한 중복만 걸러진다.
export async function dispatchNotification(input: DispatchNotificationInput): Promise<NotificationDelivery | null> {
  const baseRecord = {
    userId: input.userId,
    watchJobId: input.watchJobId,
    candidateId: input.candidateId,
    channel: input.channel,
    deviceId: input.deviceId,
    watchCycle: input.watchCycle,
    eventType: input.eventType,
    idempotencyKey: input.idempotencyKey,
  };

  if (!input.deviceVerified) {
    return recordNotificationDelivery({ ...baseRecord, status: "skipped_unverified", deliveryRef: null });
  }

  if (hasDeliveredNotification(input.userId, input.idempotencyKey)) {
    return recordNotificationDelivery({ ...baseRecord, status: "skipped_duplicate", deliveryRef: null });
  }

  const adapter = getNotificationAdapter(input.channel);
  try {
    const result = await adapter.send({
      userId: input.userId,
      watchJobId: input.watchJobId,
      candidateId: input.candidateId,
      channel: input.channel,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      destination: input.destination,
      title: input.title,
      body: input.body,
    });
    return recordNotificationDelivery({
      ...baseRecord,
      status: result.delivered ? "delivered" : "failed",
      deliveryRef: result.deliveryRef,
    });
  } catch (error) {
    if (error instanceof WatchError) {
      return recordNotificationDelivery({ ...baseRecord, status: "failed", deliveryRef: null });
    }
    throw error;
  }
}
