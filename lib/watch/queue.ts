import "server-only";

// In-memory/test-only FIFO, same design (and the same lesson from v0.4's
// PR #7 review) as lib/reservation/queue.ts: idempotency is scoped to
// (userId, jobId, idempotencyKey), never the raw key alone, so two different
// users or jobs reusing the same client-generated key are never treated as
// duplicates of each other. NOT a production queue -- see
// docs/adr/0002-auth-storage-notification.md.
export type WatchQueueMessage = {
  jobId: string;
  userId: string;
  idempotencyKey: string;
};

const pending: WatchQueueMessage[] = [];
const seenIdempotencyKeys = new Set<string>();

function idempotencyScope(message: WatchQueueMessage): string {
  return `${message.userId}::${message.jobId}::${message.idempotencyKey}`;
}

export function enqueue(message: WatchQueueMessage): "queued" | "duplicate" {
  const scope = idempotencyScope(message);
  if (seenIdempotencyKeys.has(scope)) {
    return "duplicate";
  }
  seenIdempotencyKeys.add(scope);
  pending.push(message);
  return "queued";
}

export function dequeue(): WatchQueueMessage | undefined {
  return pending.shift();
}

export function queueSize(): number {
  return pending.length;
}

export function __resetQueueForTests(): void {
  pending.length = 0;
  seenIdempotencyKeys.clear();
}
