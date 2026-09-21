import "server-only";

import type { AuditEvent, AuditStore } from "@/lib/audit/types";

// Process-memory only, exactly like lib/auth/memory-store.ts and
// lib/watch/store.ts's own tables: resets on every cold start/redeploy,
// never shared across serverless instances. This is the seam a persistent
// (Postgres) implementation plugs into -- see lib/audit/types.ts's
// AuditStore contract and db/postgres/migrations/0001_init.sql's
// audit_events table.
const auditEvents: AuditEvent[] = [];

function generateId(): string {
  return `audit_${crypto.randomUUID().replace(/-/g, "")}`;
}

export const memoryAuditStore: AuditStore = {
  record(userId, action, targetId, metadata) {
    const event: AuditEvent = { id: generateId(), userId, action, targetId, at: new Date().toISOString(), metadata };
    auditEvents.push(event);
    return event;
  },

  listForUser(userId) {
    return auditEvents.filter((e) => e.userId === userId);
  },

  pseudonymizeForUser(userId) {
    const pseudonym = crypto.randomUUID();
    for (let i = 0; i < auditEvents.length; i += 1) {
      if (auditEvents[i].userId === userId) {
        auditEvents[i] = { ...auditEvents[i], userId: pseudonym };
      }
    }
  },
};

// Test-only: exposes every AuditEvent regardless of userId, so a test can
// look up an account's events *by their post-deletion pseudonym* (which the
// test only learns by scanning, since listForUser(originalUserId)
// deliberately returns nothing any more once pseudonymized).
export function __listAllAuditEventsForTests(): AuditEvent[] {
  return auditEvents.slice();
}

// Test-only: clears every in-memory audit event between independent test scenarios.
export function __resetAuditStoreForTests(): void {
  auditEvents.length = 0;
}
