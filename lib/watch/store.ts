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
  type NotificationClaim,
  type NotificationClaimInput,
  type NotificationDelivery,
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
// Outbox/claim table: exactly one row per (userId, idempotencyKey) -- see the
// NotificationDelivery doc comment in types.ts. Keyed by `${userId}::${idempotencyKey}`.
const notificationOutbox = new Map<string, NotificationDelivery>();
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

// -- Notification outbox/claim -------------------------------------------------

// §6 재검토: 발송 전 원자적 claim. 두 호출자(예: 겹쳐 실행된 Worker 두 개)가
// 정확히 같은 (userId, idempotencyKey)로 동시에 이 함수를 호출해도, 이
// Map은 동기적으로 갱신되고 Node.js는 단일 스레드이므로 -- 이 함수 안에는
// `await`이 전혀 없다 -- 둘 중 먼저 실행을 시작한 호출만 "claimed"를 받고
// 나머지는 즉시 "duplicate"/"already_claimed"를 받는다. 이 claim에
// *성공한* 호출자만 실제 Adapter를 호출해야 한다(dispatch.ts). 이전 구현은
// "hasDeliveredNotification() 확인 -> await adapter.send() -> 저장" 순서라,
// 확인과 저장 사이의 await 구간에서 두 호출 모두 확인을 통과할 수 있었다 --
// 이 claim은 그 구간을 없앤다(확인이자 저장이 같은 동기 연산).
//
// 실제 Postgres 구현에서는 이 함수 하나가 다음 SQL과 같아야 한다(자세한
// 설계와 조건부 재획득 UPDATE는 db/postgres/migrations/0001_init.sql 참고):
//   insert into notification_deliveries (...) values (...)
//   on conflict (user_id, idempotency_key) do nothing
//   returning *;
//   -- 0행이 반환되면 이미 존재하는 행을 select해 duplicate/already_claimed/
//   -- 재시도 가능 여부를 판단하고, 필요하면 조건부 UPDATE로 재획득을 시도한다.
// 테스트 전용 오버라이드: 기본 30초 lease는 자동화된 테스트에서 실시간으로
// 기다리기엔 너무 길다. NOTIFICATION_CLAIM_LEASE_MS를 지정하면(예:
// scripts/verify-seat-watch.cjs) 그 값을 쓰고, 그 외에는 항상 30초다 --
// 운영 코드 경로는 이 환경변수를 설정하지 않으므로 영향이 없다.
function getClaimLeaseMs(): number {
  const raw = Number(process.env.NOTIFICATION_CLAIM_LEASE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

function isLeaseExpired(lockExpiresAt: string | null, now: number): boolean {
  return lockExpiresAt === null || new Date(lockExpiresAt).getTime() <= now;
}

function isRetryDue(nextAttemptAt: string | null, now: number): boolean {
  return nextAttemptAt === null || new Date(nextAttemptAt).getTime() <= now;
}

function reclaimEntry(existing: NotificationDelivery, now: number): NotificationDelivery {
  return {
    ...existing,
    status: "sending",
    attemptCount: existing.attemptCount + 1,
    lockedAt: nowIso(now),
    lockExpiresAt: nowIso(now + getClaimLeaseMs()),
    updatedAt: nowIso(now),
  };
}

export function claimNotification(input: NotificationClaimInput): NotificationClaim {
  const scope = `${input.userId}::${input.idempotencyKey}`;
  const now = Date.now();
  const existing = notificationOutbox.get(scope);

  if (!existing) {
    const entry: NotificationDelivery = {
      id: generateId("notif"),
      ...input,
      status: "sending",
      deliveryRef: null,
      attemptCount: 1,
      lastError: null,
      nextAttemptAt: null,
      lockedAt: nowIso(now),
      lockExpiresAt: nowIso(now + getClaimLeaseMs()),
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    };
    notificationOutbox.set(scope, entry);
    return { outcome: "claimed", entry };
  }

  if (existing.status === "delivered" || existing.status === "skipped_unverified") {
    // 이미 끝난 알림 -- 절대 다시 보내지 않는다(§6: 완전한 중복만 걸러짐).
    return { outcome: "duplicate", entry: existing };
  }

  if (existing.status === "sending") {
    if (!isLeaseExpired(existing.lockExpiresAt, now)) {
      // 다른 호출자가 지금 이 알림을 처리 중이다 -- 절대 어댑터를 또 호출하지 않는다.
      return { outcome: "already_claimed", entry: existing };
    }
    // lease가 만료됨(예: Worker가 중간에 죽음) -- 방치된 claim으로 보고 재획득한다.
    const reclaimed = reclaimEntry(existing, now);
    notificationOutbox.set(scope, reclaimed);
    return { outcome: "claimed", entry: reclaimed };
  }

  // existing.status === "failed" | "pending"
  if (!isRetryDue(existing.nextAttemptAt, now)) {
    return { outcome: "already_claimed", entry: existing };
  }
  const reclaimed = reclaimEntry(existing, now);
  notificationOutbox.set(scope, reclaimed);
  return { outcome: "claimed", entry: reclaimed };
}

export type CompleteNotificationClaimResult = {
  delivered: boolean;
  deliveryRef: string | null;
  error?: string | null;
};

// claimNotification()이 "claimed"를 반환했을 때만 호출한다 -- 실제 Adapter
// 호출이 끝난 뒤 그 claim을 종료 상태로 전이시킨다. 실패 시 nextAttemptAt을
// 즉시(지금)로 설정해 다음 Worker tick이 바로 재시도를 claim할 수 있게 한다
// (이 인메모리 구현은 지수 백오프를 모델링하지 않는다 -- 실제 어댑터가
// 백오프가 필요하면 이 값을 미래 시각으로 설정하면 된다).
export function completeNotificationClaim(
  userId: string,
  idempotencyKey: string,
  result: CompleteNotificationClaimResult,
): NotificationDelivery {
  const scope = `${userId}::${idempotencyKey}`;
  const existing = notificationOutbox.get(scope);
  if (!existing) {
    throw new Error(`completeNotificationClaim called without a prior claim for ${idempotencyKey}`);
  }
  const now = Date.now();
  const updated: NotificationDelivery = {
    ...existing,
    status: result.delivered ? "delivered" : "failed",
    deliveryRef: result.delivered ? result.deliveryRef : existing.deliveryRef,
    lastError: result.delivered ? null : (result.error ?? "알림 발송에 실패했습니다."),
    nextAttemptAt: result.delivered ? null : nowIso(now),
    lockedAt: null,
    lockExpiresAt: null,
    updatedAt: nowIso(now),
  };
  notificationOutbox.set(scope, updated);
  return updated;
}

// §5 검토사항: 소유권이 확인되지 않은 수신처는 claim/lease 없이 곧바로 종료
// 상태로 기록한다 -- 애초에 Adapter를 호출할 일이 없으므로 경쟁 조건도 없다.
// 같은 키로 다시 호출되면(예: Worker 재실행) 기존 행을 그대로 반환한다.
export function recordSkippedUnverified(input: NotificationClaimInput): NotificationDelivery {
  const scope = `${input.userId}::${input.idempotencyKey}`;
  const existing = notificationOutbox.get(scope);
  if (existing) return existing;
  const now = Date.now();
  const entry: NotificationDelivery = {
    id: generateId("notif"),
    ...input,
    status: "skipped_unverified",
    deliveryRef: null,
    attemptCount: 0,
    lastError: null,
    nextAttemptAt: null,
    lockedAt: null,
    lockExpiresAt: null,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };
  notificationOutbox.set(scope, entry);
  return entry;
}

export function hasDeliveredNotification(userId: string, idempotencyKey: string): boolean {
  return notificationOutbox.get(`${userId}::${idempotencyKey}`)?.status === "delivered";
}

export function listNotificationDeliveries(userId: string, watchJobId?: string): NotificationDelivery[] {
  return [...notificationOutbox.values()]
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
// 식별자가 될 수 있다. 대신 원래 userId와 아무 관계가 없는 새 값으로 되돌릴
// 수 없이 교체한다. 같은 사용자의 이벤트는 모두 같은 가명을 공유하므로
// "삭제된 계정 하나의 활동 이력"이라는 감사 가치는 유지되지만, 그 가명에서
// 원래 userId(따라서 이메일 등 계정 정보)로 역추적할 방법은 없다.
//
// (검토 재반영) 가명은 반드시 `crypto.randomUUID()`가 만드는 그대로의 UUID
// 문자열이어야 한다 -- 이전 구현은 `deleted_<hex>` 형태의 접두사 문자열을
// 썼는데, db/postgres/migrations의 `audit_events.user_id`는 `uuid not null`
// 컬럼이라 그 값은 Postgres Adapter로 옮기면 타입 오류가 난다. 원래 userId와
// 가명 UUID 사이의 매핑은 어디에도 저장하지 않는다 -- 저장하면 역추적이
// 다시 가능해져 가명처리의 의미가 없어진다.
function pseudonymizeAuditEventsForUser(userId: string): void {
  const pseudonym = crypto.randomUUID();
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
  for (const [key, entry] of notificationOutbox) if (entry.userId === userId) notificationOutbox.delete(key);
  for (let i = consentHistory.length - 1; i >= 0; i -= 1) if (consentHistory[i].userId === userId) consentHistory.splice(i, 1);
  pseudonymizeAuditEventsForUser(userId);
}

// Test-only: exposes every AuditEvent regardless of userId, so a test can
// look up an account's events *by their post-deletion pseudonym* (which the
// test only learns by scanning, since listAuditEvents(originalUserId)
// deliberately returns nothing any more once pseudonymized).
export function __listAllAuditEventsForTests(): AuditEvent[] {
  return auditEvents.slice();
}

// Test-only: clears every in-memory table so scripts/verify-seat-watch.cjs
// can run independent scenarios without cross-contaminating dedupe checks.
export function __resetWatchStoreForTests(): void {
  watchJobs.clear();
  devices.clear();
  notificationOutbox.clear();
  consentHistory.length = 0;
  auditEvents.length = 0;
}
