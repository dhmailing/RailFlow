import "server-only";

// In-memory/test-only FIFO. It is NOT a production queue: it holds no
// durability across cold starts, has no visibility timeout, and lives inside
// a single serverless instance's memory. Real deployments must replace this
// with an external queue (see docs/adr/0001-reservation-queue-worker-storage.md)
// -- this module exists only to keep the Queue/Worker interface decoupled from
// Vercel's request lifecycle from day one, per the v0.4 foundation scope.
export type ReservationQueueMessage = {
  jobId: string;
  userId: string;
  idempotencyKey: string;
};

const pending: ReservationQueueMessage[] = [];
const seenIdempotencyKeys = new Set<string>();

// Idempotency is scoped to (userId, jobId, idempotencyKey), not the raw key
// alone -- two different users or jobs are free to reuse the same client-
// generated key, and only a retry of the *same* job's *same* logical step
// should ever be treated as a duplicate.
function idempotencyScope(message: ReservationQueueMessage): string {
  return `${message.userId}::${message.jobId}::${message.idempotencyKey}`;
}

export function enqueue(message: ReservationQueueMessage): "queued" | "duplicate" {
  const scope = idempotencyScope(message);
  if (seenIdempotencyKeys.has(scope)) {
    return "duplicate";
  }
  seenIdempotencyKeys.add(scope);
  pending.push(message);
  return "queued";
}

export function dequeue(): ReservationQueueMessage | undefined {
  return pending.shift();
}

export function queueSize(): number {
  return pending.length;
}

export function __resetQueueForTests(): void {
  pending.length = 0;
  seenIdempotencyKeys.clear();
}
