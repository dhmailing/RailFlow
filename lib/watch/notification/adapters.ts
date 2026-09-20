import "server-only";

import { WatchError, type NotificationAdapter, type NotificationChannel } from "@/lib/watch/types";

// Test/dev-only sink. Stores every payload in process memory instead of
// calling any external service -- never a network request. This is the
// "테스트용 InMemory Notification Adapter" from §E, and it is the default and
// only working adapter this PR ships.
const delivered: Array<{ deliveryRef: string; sentAt: string; payload: unknown }> = [];

export function createInMemoryNotificationAdapter(channel: NotificationChannel): NotificationAdapter {
  return {
    channel,
    async send(payload) {
      const deliveryRef = `inmemory_${crypto.randomUUID().replace(/-/g, "")}`;
      delivered.push({ deliveryRef, sentAt: new Date().toISOString(), payload });
      return { delivered: true, deliveryRef };
    },
  };
}

export function listInMemoryDeliveries() {
  return delivered.slice();
}

export function __resetInMemoryNotificationsForTests(): void {
  delivered.length = 0;
}

// FCM/WebPush/Telegram/Email all resolve to this in Production, and in
// development/test whenever no real credential is configured: §E requires
// this PR to ship without requiring any external account or live service
// key, so there is currently no code path that calls a real push/SMS/email
// provider. A future PR wires a real SDK behind the same NotificationAdapter
// interface per channel; until then every send attempt fails closed with a
// structured error instead of silently doing nothing or throwing a raw
// network error.
export function createNotConfiguredNotificationAdapter(channel: NotificationChannel): NotificationAdapter {
  return {
    channel,
    async send() {
      throw new WatchError(
        "NOTIFICATION_NOT_CONFIGURED",
        `${channel} 알림은 아직 실제 서비스 키가 연결되지 않아 발송할 수 없습니다.`,
      );
    },
  };
}
