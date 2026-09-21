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
// 않는다.
//
// (재검토, fencing token) claim에 성공해도 Adapter 호출이 오래 걸리는 동안
// lease가 만료되어 다른 Worker가 재획득할 수 있다 -- 그래서 완료 처리
// (completeNotificationClaim)는 claim 시 받은 claimToken을 그대로 넘기고,
// 저장소가 그 토큰이 여전히 유효한지 검사한다. 검사에 실패하면(다른
// Worker가 이미 재획득/완료했다는 뜻) 이 호출은 저장된 행을 절대 덮어쓰지
// 않고, 그 대신 현재(더 최신) 상태를 그대로 반환한다.
//
// 전달 보장 수준에 대한 솔직한 고지: 이 저장소 내부 claim은 "같은 저장소를
// 보는 두 호출자가 동시에 발송하는" 경쟁을 없애지만, Worker가 어댑터 호출을
// 실제로 완료한 뒤 그 결과를 이 저장소에 기록하기 *전*에 죽으면(예: 프로세스
// 강제 종료), 다음 재시도가 같은 알림을 다시 외부로 보낼 수 있다 -- 이
// 저장소만으로는 "정확히 한 번(exactly-once)" 외부 전달을 보장할 수 없다.
// 이 구현이 실제로 보장하는 것은 최소 한 번(at-least-once) 전달과, 저장소
// 상태 자체의 일관성(같은 idempotencyKey에 대해 서로 다른 두 결과가 동시에
// "최종 상태"로 남는 일이 없다는 것)뿐이다. 외부 알림 Provider가 자체
// 멱등키를 지원하면(FCM/이메일 발송 서비스 등 다수가 지원) 이
// idempotencyKey를 그 Provider에도 그대로 전달해, Provider 쪽에서도 같은
// 재시도가 중복 도달하지 않도록 하는 것을 권장한다(이번 PR은 실제 Provider
// 연동이 없어 아직 적용하지 않았다).
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

  const { claimToken } = claim;
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
    const outcome = completeNotificationClaim(input.userId, input.idempotencyKey, claimToken, {
      delivered: result.delivered,
      deliveryRef: result.deliveryRef,
      error: result.delivered ? null : "어댑터가 발송 실패를 반환했습니다.",
    });
    // outcome.entry는 applied:true면 우리가 방금 쓴 최종 상태, applied:false
    // (stale_claim)면 다른 Worker가 이미 확정한 더 최신 상태다 -- 어느
    // 쪽이든 저장소의 현재 진실을 그대로 반환한다. not_claimed(행 자체가
    // 사라짐 -- 계정 삭제와의 경합 등 극히 드문 경우)에서만 우리가 갖고
    // 있던 claim 시점의 스냅숏으로 대체한다.
    return outcome.entry ?? claim.entry;
  } catch (error) {
    if (error instanceof WatchError) {
      // 실제 알림 목적지 원문이나 비밀값을 오류에 남기지 않는다 -- 구조화된
      // WatchError.message만 기록한다(어댑터가 destination을 오류 메시지에
      // 넣지 않는다는 전제는 lib/watch/notification/adapters.ts 참고).
      const outcome = completeNotificationClaim(input.userId, input.idempotencyKey, claimToken, {
        delivered: false,
        deliveryRef: null,
        error: error.message,
      });
      return outcome.entry ?? claim.entry;
    }
    throw error;
  }
}
