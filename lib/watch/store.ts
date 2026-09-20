import "server-only";

import { assertTransition, isTerminalStatus } from "@/lib/watch/state-machine";
import {
  WatchError,
  type AuditAction,
  type AuditEvent,
  type ConsentHistoryEntry,
  type ConsentType,
  type Device,
  type JobStatus,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationEventType,
  type WatchErrorCode,
  type WatchJob,
  type WatchJobInput,
} from "@/lib/watch/types";

// Process-memory only, exactly like lib/reservation/job-store.ts in v0.4:
// resets on every cold start/redeploy, never shared across serverless
// instances. This is the seam a persistent (Postgres) implementation plugs
// into -- see db/postgres/migrations for the schema this interface maps to,
// and docs/adr/0002 for why Postgres was chosen. Nothing here is wired to a
// real database.
const watchJobs = new Map<string, WatchJob>();
const devices = new Map<string, Device>();
const notificationDeliveries = new Map<string, NotificationDelivery>();
// Only a *successful* delivery is added to this set -- a "failed" attempt
// must NOT poison it, or a real transient failure could never be retried.
// See recordNotificationDelivery below and lib/watch/notification/dispatch.ts.
const notificationIdempotencyKeys = new Set<string>(); // `${userId}::${idempotencyKey}`
const consentHistory: ConsentHistoryEntry[] = [];
const auditEvents: AuditEvent[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

// -- Devices -----------------------------------------------------------------

export function registerDevice(userId: string, channel: NotificationChannel, token: string, label: string | null): Device {
  const now = new Date().toISOString();
  const existing = [...devices.values()].find((d) => d.userId === userId && d.channel === channel && d.token === token);
  if (existing) {
    const updated: Device = { ...existing, lastSeenAt: now, label: label ?? existing.label };
    devices.set(updated.id, updated);
    return updated;
  }
  const device: Device = { id: generateId("device"), userId, channel, token, label, createdAt: now, lastSeenAt: now };
  devices.set(device.id, device);
  recordAuditEvent(userId, "device_registered", device.id, { channel });
  return device;
}

export function listDevices(userId: string): Device[] {
  return [...devices.values()].filter((d) => d.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDevice(id: string, userId: string): Device {
  const device = devices.get(id);
  if (!device || device.userId !== userId) {
    throw new WatchError("INVALID_DEVICE", "등록되지 않은 알림 수신 기기입니다.");
  }
  return device;
}

// -- WatchJobs -----------------------------------------------------------------

function dedupeKey(input: Pick<WatchJobInput, "userId" | "departureId" | "arrivalId" | "date" | "passengers">): string {
  return [input.userId, input.departureId, input.arrivalId, input.date, input.passengers].join("|");
}

function hasActiveDuplicate(input: WatchJobInput): boolean {
  const key = dedupeKey(input);
  for (const job of watchJobs.values()) {
    if (isTerminalStatus(job.status)) continue;
    if (dedupeKey(job) === key) return true;
  }
  return false;
}

export function createWatchJob(input: WatchJobInput, seatProvider: "unavailable" | "mock"): WatchJob {
  if (hasActiveDuplicate(input)) {
    throw new WatchError("DUPLICATE_JOB", "같은 사용자·날짜·구간·인원의 감시 작업이 이미 진행 중입니다.");
  }
  for (const method of input.notificationMethods) {
    getDevice(method.deviceId, input.userId); // throws INVALID_DEVICE on mismatch/ownership failure
  }

  const now = new Date().toISOString();
  const job: WatchJob = {
    ...input,
    id: generateId("watch"),
    status: "REGISTERED",
    seatProvider,
    simulation: seatProvider === "mock",
    foundCandidateId: null,
    foundAt: null,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lastError: null,
    history: [{ at: now, from: null, to: "REGISTERED", reason: "감시 작업 등록" }],
  };
  watchJobs.set(job.id, job);
  recordAuditEvent(input.userId, "watch_job_created", job.id, { departure: input.departure, arrival: input.arrival, date: input.date });
  return job;
}

export function listWatchJobs(userId: string): WatchJob[] {
  return [...watchJobs.values()].filter((job) => job.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Ownership is enforced here, not just by filtering: a job id belonging to
// another user resolves to NOT_FOUND, identical to a nonexistent id, so a
// guessed/enumerated id can never be distinguished from a wrong one (§6 다른
// 사용자의 작업 ID 추측 접근 차단).
export function getWatchJob(id: string, userId: string): WatchJob {
  const job = watchJobs.get(id);
  if (!job || job.userId !== userId) {
    throw new WatchError("NOT_FOUND", "감시 작업을 찾을 수 없습니다.");
  }
  return job;
}

export type WatchJobTransitionPatch = Partial<
  Pick<WatchJob, "foundCandidateId" | "foundAt" | "attempts" | "lastError" | "seatProvider" | "simulation">
>;

export function transitionWatchJob(
  id: string,
  userId: string,
  to: JobStatus,
  reason: string,
  patch: WatchJobTransitionPatch = {},
): WatchJob {
  const job = getWatchJob(id, userId);
  assertTransition(job.status, to);
  const now = new Date().toISOString();
  const updated: WatchJob = {
    ...job,
    ...patch,
    status: to,
    updatedAt: now,
    history: [...job.history, { at: now, from: job.status, to, reason }],
  };
  watchJobs.set(id, updated);
  if (to === "COMPLETED") recordAuditEvent(userId, "watch_job_completed", id, null);
  return updated;
}

export function recordAttempt(id: string, userId: string, error: { code: WatchErrorCode; message: string } | null): WatchJob {
  const job = getWatchJob(id, userId);
  const updated: WatchJob = { ...job, attempts: job.attempts + 1, lastError: error, updatedAt: new Date().toISOString() };
  watchJobs.set(id, updated);
  return updated;
}

export function cancelWatchJob(id: string, userId: string, reason = "사용자 취소"): WatchJob {
  const job = transitionWatchJob(id, userId, "CANCELLED", reason);
  recordAuditEvent(userId, "watch_job_cancelled", id, null);
  return job;
}

// -- Notification deliveries --------------------------------------------------

export type RecordNotificationInput = {
  userId: string;
  watchJobId: string;
  candidateId: string | null;
  channel: NotificationChannel;
  eventType: NotificationEventType;
  idempotencyKey: string;
  status: "delivered" | "failed" | "skipped_duplicate";
  deliveryRef: string | null;
};

// Idempotency is scoped to (userId, idempotencyKey) -- the same lesson v0.4's
// review taught about queue.ts: never key a dedupe check on a raw
// client/caller-supplied string alone. Only a "delivered" outcome marks the
// key as used; "failed" always writes an audit row but leaves the key open
// so the next Worker tick can retry the same logical notification, and
// "skipped_duplicate" is the caller (dispatch.ts) explicitly logging that it
// chose not to resend. Returns `null` only when a caller passes a
// non-"skipped_duplicate" status for a key that is already marked delivered
// (defense in depth -- callers are expected to check hasDeliveredNotification
// first).
export function recordNotificationDelivery(input: RecordNotificationInput): NotificationDelivery | null {
  const scope = `${input.userId}::${input.idempotencyKey}`;
  if (input.status !== "skipped_duplicate" && notificationIdempotencyKeys.has(scope)) {
    return null;
  }
  const delivery: NotificationDelivery = { id: generateId("notif"), createdAt: new Date().toISOString(), ...input };
  notificationDeliveries.set(delivery.id, delivery);
  if (input.status === "delivered") {
    notificationIdempotencyKeys.add(scope);
  }
  return delivery;
}

export function hasDeliveredNotification(userId: string, idempotencyKey: string): boolean {
  return notificationIdempotencyKeys.has(`${userId}::${idempotencyKey}`);
}

export function listNotificationDeliveries(userId: string, watchJobId?: string): NotificationDelivery[] {
  return [...notificationDeliveries.values()]
    .filter((d) => d.userId === userId && (!watchJobId || d.watchJobId === watchJobId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// -- Consent history -----------------------------------------------------------

export function recordConsent(userId: string, consentType: ConsentType, granted: boolean): ConsentHistoryEntry {
  const entry: ConsentHistoryEntry = { id: generateId("consent"), userId, consentType, granted, at: new Date().toISOString() };
  consentHistory.push(entry);
  return entry;
}

export function listConsentHistory(userId: string): ConsentHistoryEntry[] {
  return consentHistory.filter((c) => c.userId === userId);
}

// -- Audit events ----------------------------------------------------------------

// metadata must never contain secrets, tokens, or raw notification
// destinations -- callers pass only short descriptive strings (see the
// call sites above). scripts/verify-seat-watch.cjs asserts no secret value
// ever appears in an audit event.
export function recordAuditEvent(userId: string, action: AuditAction, targetId: string | null, metadata: Record<string, string> | null): AuditEvent {
  const event: AuditEvent = { id: generateId("audit"), userId, action, targetId, at: new Date().toISOString(), metadata };
  auditEvents.push(event);
  return event;
}

export function listAuditEvents(userId: string): AuditEvent[] {
  return auditEvents.filter((e) => e.userId === userId);
}

// -- Account deletion ------------------------------------------------------------

// Removes every row this module owns for `userId` (Devices, WatchJobs and
// their history, NotificationDeliveries, ConsentHistory). AuditEvents are
// deliberately kept: they hold only the now-orphaned userId, an action name,
// and a target id -- no email, token, or destination -- so retaining them
// for security/audit integrity does not retain personal data. Documented in
// docs/V0.5-SEAT-WATCH.md.
export function deleteAllWatchDataForUser(userId: string): void {
  for (const [id, job] of watchJobs) if (job.userId === userId) watchJobs.delete(id);
  for (const [id, device] of devices) if (device.userId === userId) devices.delete(id);
  for (const [id, delivery] of notificationDeliveries) if (delivery.userId === userId) notificationDeliveries.delete(id);
  for (const key of notificationIdempotencyKeys) if (key.startsWith(`${userId}::`)) notificationIdempotencyKeys.delete(key);
  for (let i = consentHistory.length - 1; i >= 0; i -= 1) if (consentHistory[i].userId === userId) consentHistory.splice(i, 1);
}

// Test-only: clears every in-memory table so scripts/verify-seat-watch.cjs
// can run independent scenarios without cross-contaminating dedupe checks.
export function __resetWatchStoreForTests(): void {
  watchJobs.clear();
  devices.clear();
  notificationDeliveries.clear();
  notificationIdempotencyKeys.clear();
  consentHistory.length = 0;
  auditEvents.length = 0;
}
