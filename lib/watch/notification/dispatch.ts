import "server-only";

import { getNotificationAdapter } from "@/lib/watch/notification/get-adapter";
import { claimNotification, completeNotificationClaim, recordSkippedUnverified } from "@/lib/watch/store";
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

// (재검토, §6) 발송 "전"에 원자적으로 소유권(claim)을 획득한 호출자만 실제
// Adapter를 호출한다. 두 호출자가 동시에 같은 idempotencyKey로 이 함수를
// 부르면(예: Worker 두 개가 겹쳐 실행) claimNotification()이 오직 하나에게만
// "claimed"를 돌려주므로, 나머지는 여기서 즉시 반환하고 어댑터를 절대 건드리지
// 않는다. 이전 구현("이미 성공했는지 확인 -> await로 어댑터 호출 -> 저장")은
// 확인과 저장 사이의 await 구간에서 두 호출 모두 확인을 통과할 수 있었다 --
// 그 구간이 사라졌다.
export async function dispatchNotification(input: DispatchNotificationInput): Promise<NotificationDelivery> {
  const claimInput = {
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
    return recordSkippedUnverified(claimInput);
  }

  const claim = claimNotification(claimInput);
  if (claim.outcome !== "claimed") {
    // "duplicate": 이미 delivered/skipped_unverified로 끝난 알림.
    // "already_claimed": 다른 호출자가 지금 처리 중이거나, 아직 재시도 시각이 되지 않음.
    // 어느 쪽이든 이 호출은 어댑터를 절대 호출하지 않는다.
    return claim.entry;
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
    return completeNotificationClaim(input.userId, input.idempotencyKey, {
      delivered: result.delivered,
      deliveryRef: result.deliveryRef,
      error: result.delivered ? null : "어댑터가 발송 실패를 반환했습니다.",
    });
  } catch (error) {
    if (error instanceof WatchError) {
      // 실제 알림 목적지 원문이나 비밀값을 오류에 남기지 않는다 -- 구조화된
      // WatchError.message만 기록한다(어댑터가 destination을 오류 메시지에
      // 넣지 않는다는 전제는 lib/watch/notification/adapters.ts 참고).
      return completeNotificationClaim(input.userId, input.idempotencyKey, {
        delivered: false,
        deliveryRef: null,
        error: error.message,
      });
    }
    throw error;
  }
}
