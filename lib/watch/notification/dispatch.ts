import "server-only";

import { getNotificationAdapter } from "@/lib/watch/notification/get-adapter";
import { hasDeliveredNotification, recordNotificationDelivery } from "@/lib/watch/store";
import { WatchError, type NotificationChannel, type NotificationDelivery, type NotificationEventType } from "@/lib/watch/types";

export type DispatchNotificationInput = {
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  eventType: NotificationEventType;
  idempotencyKey: string;
  destination: string;
  title: string;
  body: string;
};

// A previously *delivered* notification with this idempotencyKey short-
// circuits to a "skipped_duplicate" row without calling the adapter again.
// A previously *failed* attempt does not: the adapter is called again, so a
// transient failure is retryable on the next Worker tick with the same key.
export async function dispatchNotification(input: DispatchNotificationInput): Promise<NotificationDelivery | null> {
  if (hasDeliveredNotification(input.userId, input.idempotencyKey)) {
    return recordNotificationDelivery({
      userId: input.userId,
      watchJobId: input.watchJobId,
      candidateId: input.candidateId,
      channel: input.channel,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      status: "skipped_duplicate",
      deliveryRef: null,
    });
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
      userId: input.userId,
      watchJobId: input.watchJobId,
      candidateId: input.candidateId,
      channel: input.channel,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      status: result.delivered ? "delivered" : "failed",
      deliveryRef: result.deliveryRef,
    });
  } catch (error) {
    if (error instanceof WatchError) {
      return recordNotificationDelivery({
        userId: input.userId,
        watchJobId: input.watchJobId,
        candidateId: input.candidateId,
        channel: input.channel,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        status: "failed",
        deliveryRef: null,
      });
    }
    throw error;
  }
}
