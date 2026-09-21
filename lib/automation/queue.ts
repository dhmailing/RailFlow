import "server-only";

// Mirrors lib/reservation/queue.ts exactly -- an in-memory/test-only FIFO,
// not a production queue. See docs/V0.7-BOOKING-MACRO-SIMULATOR.md for the
// real Queue/Worker this must become before any production use.
export type AutomationQueueMessage = {
  jobId: string;
  userId: string;
  idempotencyKey: string;
};

const pending: AutomationQueueMessage[] = [];
const seenIdempotencyKeys = new Set<string>();

function idempotencyScope(message: AutomationQueueMessage): string {
  return `${message.userId}::${message.jobId}::${message.idempotencyKey}`;
}

export function enqueue(message: AutomationQueueMessage): "queued" | "duplicate" {
  const scope = idempotencyScope(message);
  if (seenIdempotencyKeys.has(scope)) {
    return "duplicate";
  }
  seenIdempotencyKeys.add(scope);
  pending.push(message);
  return "queued";
}

export function dequeue(): AutomationQueueMessage | undefined {
  return pending.shift();
}

export function queueSize(): number {
  return pending.length;
}

export function __resetQueueForTests(): void {
  pending.length = 0;
  seenIdempotencyKeys.clear();
}
