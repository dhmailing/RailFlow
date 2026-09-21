import "server-only";

import { validateCandidates } from "@/lib/watch/candidate-validation";
import { isWatchStoreUsable } from "@/lib/watch/feature-flags";
import { assertTransition, isTerminalStatus } from "@/lib/watch/state-machine";
import {
  WatchError,
  type AuditAction,
  type AuditEvent,
  type ConsentHistoryEntry,
  type ConsentType,
  type Device,
  type DeviceSummary,
  type JobStatus,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationDeliveryStatus,
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

// §1 검토사항: WATCH_STORE가 usable하지 않으면(운영 환경 등) 어떤 쓰기 작업도
// 수행하지 않는다 -- AUTH_STORE와 독립적인 게이트다(lib/auth/store.ts 참고).
function assertWatchStoreUsable(): void {
  if (!isWatchStoreUsable()) {
    throw new WatchError(
      "WATCH_STORE_DISABLED",
      "취소표 감시 저장소가 아직 준비되지 않았습니다. 실제 운영 저장소가 연결되지 않았습니다.",
    );
  }
}

// -- Devices -----------------------------------------------------------------

// fcm/webpush는 브라우저·OS가 발급한 값이라 다른 사용자의 것을 자유롭게
// 대신 입력할 수 없으므로 등록 즉시 verified=true로 취급한다. email/telegram은
// 누구나 임의의 값을 입력할 수 있어 소유권 확인 절차(이번 PR에는 없음) 전까지
// 항상 unverified다(§5).
function isChannelVerifiedOnRegistration(channel: NotificationChannel): boolean {
  return channel === "fcm" || channel === "webpush";
}

function maskDestination(token: string, channel: NotificationChannel): string {
  if (channel === "email") {
    const atIndex = token.indexOf("@");
    if (atIndex <= 0) return "••••";
    const local = token.slice(0, atIndex);
    const domain = token.slice(atIndex + 1);
    return `${local.slice(0, 1)}${"•".repeat(Math.max(local.length - 1, 2))}@${domain}`;
  }
  if (token.length <= 4) return "•".repeat(Math.max(token.length, 4));
  return `${"•".repeat(Math.max(token.length - 4, 4))}${token.slice(-4)}`;
}

// §5 검토사항: API/UI에는 절대 원문 token을 내려주지 않는다.
export function toDeviceSummary(device: Device): DeviceSummary {
  return {
    id: device.id,
    channel: device.channel,
    maskedDestination: maskDestination(device.token, device.channel),
    verified: device.verified,
    label: device.label,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export function registerDevice(userId: string, channel: NotificationChannel, token: string, label: string | null): Device {
  assertWatchStoreUsable();
  const now = new Date().toISOString();
  const existing = [...devices.values()].find((d) => d.userId === userId && d.channel === channel && d.token === token);
  if (existing) {
    const updated: Device = { ...existing, lastSeenAt: now, label: label ?? existing.label };
    devices.set(updated.id, updated);
    return updated;
  }
  const device: Device = {
    id: generateId("device"),
    userId,
    channel,
    token,
    verified: isChannelVerifiedOnRegistration(channel),
    label,
    createdAt: now,
    lastSeenAt: now,
  };
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
  assertWatchStoreUsable();
  if (hasActiveDuplicate(input)) {
    throw new WatchError("DUPLICATE_JOB", "같은 사용자·날짜·구간·인원의 감시 작업이 이미 진행 중입니다.");
  }
  validateCandidates(input);
  for (const method of input.notificationMethods) {
    const device = getDevice(method.deviceId, input.userId); // throws INVALID_DEVICE on mismatch/ownership failure
    if (device.channel !== method.channel) {
      throw new WatchError(
        "NOTIFICATION_CHANNEL_MISMATCH",
        `등록된 기기(${device.channel})와 다른 알림 방식(${method.channel})을 지정했습니다.`,
      );
    }
  }

  const now = new Date().toISOString();
  const job: WatchJob = {
    ...input,
    candidates: input.candidates.map((candidate) => ({ ...candidate, id: crypto.randomUUID() })),
    id: generateId("watch"),
    status: "REGISTERED",
    seatProvider,
    simulation: seatProvider === "mock",
    watchCycle: 0,
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
  Pick<WatchJob, "foundCandidateId" | "foundAt" | "attempts" | "lastError" | "seatProvider" | "simulation" | "watchCycle">
>;

export function transitionWatchJob(
  id: string,
  userId: string,
  to: JobStatus,
  reason: string,
  patch: WatchJobTransitionPatch = {},
): WatchJob {
  assertWatchStoreUsable();
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
  assertWatchStoreUsable();
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
  deviceId: string;
  watchCycle: number;
  eventType: NotificationEventType;
  idempotencyKey: string;
  status: NotificationDeliveryStatus;
  deliveryRef: string | null;
};

// Idempotency is scoped to (userId, idempotencyKey) -- the same lesson v0.4's
// review taught about queue.ts: never key a dedupe check on a raw
// client/caller-supplied string alone. The idempotencyKey itself now embeds
// channel+deviceId+watchCycle (§6 검토사항) so it never collapses across
// different channels, different devices on the same channel, or a later
// "다시 감시" generation. Only a "delivered" outcome marks the key as used;
// "failed" always writes an audit row but leaves the key open so the next
// Worker tick can retry the same logical notification, and
// "skipped_duplicate"/"skipped_unverified" are the caller (dispatch.ts)
// explicitly logging that it chose not to (re)send. Returns `null` only when
// a caller passes a "delivered"/"failed" status for a key that is already
// marked delivered (defense in depth -- callers are expected to check
// hasDeliveredNotification first).
export function recordNotificationDelivery(input: RecordNotificationInput): NotificationDelivery | null {
  const scope = `${input.userId}::${input.idempotencyKey}`;
  const isTerminalWriteAttempt = input.status === "delivered" || input.status === "failed";
  if (isTerminalWriteAttempt && notificationIdempotencyKeys.has(scope)) {
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

// §8 검토사항: AuditEvent는 보안 감사 무결성을 위해 계정 삭제 후에도
// 보존하지만(§3-B), "userId만 남아 있으니 개인정보가 아니다"라고 단정하지
// 않는다 -- userId 자체가 삭제된 계정과 다른 시스템(서버 로그 등)을 잇는
// 식별자가 될 수 있다. 대신 원래 userId와 아무 관계가 없는 새 무작위 문자열로
// 되돌릴 수 없이 교체한다. 같은 사용자의 이벤트는 모두 같은 가명을 공유하므로
// "삭제된 계정 하나의 활동 이력"이라는 감사 가치는 유지되지만, 그 가명에서
// 원래 userId(따라서 이메일 등 계정 정보)로 역추적할 방법은 없다.
function pseudonymizeAuditEventsForUser(userId: string): void {
  const pseudonym = `deleted_${crypto.randomUUID().replace(/-/g, "")}`;
  for (let i = 0; i < auditEvents.length; i += 1) {
    if (auditEvents[i].userId === userId) {
      auditEvents[i] = { ...auditEvents[i], userId: pseudonym };
    }
  }
}

// Removes every row this module owns for `userId` (Devices, WatchJobs and
// their history, NotificationDeliveries, ConsentHistory) and pseudonymizes
// this user's AuditEvents (see pseudonymizeAuditEventsForUser above).
// Documented in docs/V0.5-SEAT-WATCH.md. Runs unconditionally (not gated by
// assertWatchStoreUsable): deleting a user's own data must never be blocked
// by the same flag that blocks *creating new* fake demo data, and it is a
// harmless no-op when nothing was ever created in this process.
export function deleteAllWatchDataForUser(userId: string): void {
  for (const [id, job] of watchJobs) if (job.userId === userId) watchJobs.delete(id);
  for (const [id, device] of devices) if (device.userId === userId) devices.delete(id);
  for (const [id, delivery] of notificationDeliveries) if (delivery.userId === userId) notificationDeliveries.delete(id);
  for (const key of notificationIdempotencyKeys) if (key.startsWith(`${userId}::`)) notificationIdempotencyKeys.delete(key);
  for (let i = consentHistory.length - 1; i >= 0; i -= 1) if (consentHistory[i].userId === userId) consentHistory.splice(i, 1);
  pseudonymizeAuditEventsForUser(userId);
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
