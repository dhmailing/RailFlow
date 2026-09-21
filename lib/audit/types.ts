import "server-only";

// Shared audit trail for both lib/auth (signup/login/logout/account
// deletion) and lib/watch (watch job/device lifecycle) -- one audit trail,
// one privacy/pseudonymization policy. This used to live inside
// lib/watch/store.ts, which meant lib/auth's routes had to reach into
// lib/watch's module-private in-memory tables just to log their own
// activity, and it meant AUTH_STORE-gated code depended on a WATCH_STORE-
// gated module for something that has nothing to do with watch jobs. See
// docs/adr/0002 §9.
export type AuditAction =
  | "user_signup"
  | "user_login"
  | "user_logout"
  | "user_deleted"
  | "watch_job_created"
  | "watch_job_cancelled"
  | "watch_job_completed"
  | "device_registered";

export type AuditEvent = {
  id: string;
  userId: string;
  action: AuditAction;
  targetId: string | null;
  at: string;
  // Never put secrets, tokens, passwords, cookies, or raw notification
  // destinations in here -- see scripts/verify-seat-watch.cjs's leak
  // assertion and every call site below.
  metadata: Record<string, string> | null;
};

// Storage boundary for the audit subsystem, independent of AuthStore
// (lib/auth/types.ts) and the watch module's own in-memory tables -- see
// lib/audit/store.ts's getAuditStore() for the swap-in seam. Deliberately
// synchronous for this PR's in-memory implementation (nothing here talks to
// a database yet); a real Postgres-backed implementation would naturally
// become async, and every call site would need `await` added at that point.
//
// Contract a Postgres-backed implementation must uphold:
//   - `record()` should write its row in the SAME transaction as whatever
//     mutation it documents wherever that is practical (e.g. INSERT INTO
//     users ...; INSERT INTO audit_events ...; in one transaction for
//     signup) so the two can never disagree after a partial failure.
//   - `pseudonymizeForUser()` must generate exactly ONE fresh pseudonym
//     value and reuse it across every row for that user in a single UPDATE
//     (never a per-row `gen_random_uuid()` call, which would give each
//     event a different value). It should run inside the same
//     account-deletion transaction as the user/watch-data deletes -- see
//     the documented example transaction in
//     db/postgres/migrations/0001_init.sql.
export interface AuditStore {
  record(userId: string, action: AuditAction, targetId: string | null, metadata: Record<string, string> | null): AuditEvent;
  listForUser(userId: string): AuditEvent[];
  // Irreversibly replaces every event's userId for `userId` with a single
  // fresh pseudonym. The mapping from the original userId to the pseudonym
  // is never stored anywhere -- storing it would make the pseudonymization
  // reversible and defeat its purpose.
  pseudonymizeForUser(userId: string): void;
}
