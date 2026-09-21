import "server-only";

import { memoryAuditStore } from "@/lib/audit/memory-store";
import type { AuditStore } from "@/lib/audit/types";

// Single seam for swapping in a persistent (Postgres) implementation later
// without touching any caller -- mirrors lib/auth/store.ts's getAuthStore().
//
// Deliberately has no independent fail-closed flag of its own (no
// AUDIT_STORE env var): recording an audit event is only ever reachable
// from a code path that has already passed its own subsystem's gate
// (AUTH_STORE for signup/login/logout/account-deletion events, WATCH_STORE
// for watch-job/device events) -- see lib/auth/store.ts and
// lib/watch/store.ts. By the time record() runs, in-memory storage is
// already the intentionally-selected mode for this request, so gating it
// again here would be redundant, and an audit-write failure must never be
// allowed to block the real operation it documents.
export function getAuditStore(): AuditStore {
  return memoryAuditStore;
}
