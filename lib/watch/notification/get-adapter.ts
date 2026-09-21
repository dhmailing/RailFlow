import "server-only";

import { createInMemoryNotificationAdapter, createNotConfiguredNotificationAdapter } from "@/lib/watch/notification/adapters";
import type { NotificationAdapter, NotificationChannel } from "@/lib/watch/types";

// Every channel resolves to the same two choices: InMemory outside
// production (so the end-to-end Mock flow in §D is actually testable), or
// NotConfigured everywhere else -- most importantly, always in production,
// since this PR ships no real FCM/WebPush/Telegram/Email credentials or SDK
// calls (§E).
export function getNotificationAdapter(channel: NotificationChannel): NotificationAdapter {
  if (process.env.NODE_ENV !== "production") {
    return createInMemoryNotificationAdapter(channel);
  }
  return createNotConfiguredNotificationAdapter(channel);
}
