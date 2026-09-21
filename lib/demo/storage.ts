// sessionStorage-only persistence for the Demo Showcase (§9). Never
// localStorage, never a cookie, never a server request -- see
// lib/demo/types.ts's header. `storage` is injected (rather than reading
// `window.sessionStorage` directly) so this module can be unit-tested under
// Node with a plain in-memory object (scripts/verify-demo-showcase.cjs)
// without a DOM.
import { DEMO_STORAGE_KEY, type DemoJobState, type DemoStatus } from "@/lib/demo/types";

export type DemoStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const KNOWN_STATUSES: readonly DemoStatus[] = ["READY", "REGISTERED", "WATCHING", "SEAT_FOUND", "NOTIFIED", "FINISHED", "CANCELLED"];

// Deliberately loose structural check, not full schema validation: this
// only guards against rendering on top of corrupted or stale-shape JSON
// (e.g. a future format change) -- never trust sessionStorage content
// blindly, but there is no security boundary here since nothing sensitive
// is ever stored (§9: no email/password fields, no personal data).
function isPlausibleDemoJobState(value: unknown): value is DemoJobState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.status !== "string" || !KNOWN_STATUSES.includes(candidate.status as DemoStatus)) return false;
  if (!candidate.condition || typeof candidate.condition !== "object") return false;
  if (!Array.isArray(candidate.candidates)) return false;
  if (!Array.isArray(candidate.selectedCandidateIds)) return false;
  if (!Array.isArray(candidate.history)) return false;
  if (!Array.isArray(candidate.notifications)) return false;
  if (typeof candidate.watchTick !== "number") return false;
  return true;
}

export function readDemoState(storage: DemoStorageLike): DemoJobState | null {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPlausibleDemoJobState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDemoState(storage: DemoStorageLike, state: DemoJobState): void {
  try {
    storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable (private mode, blocked, quota exceeded) --
    // the Demo Showcase keeps working in-memory for the rest of the tab's
    // life even when persistence silently fails.
  }
}

export function clearDemoState(storage: DemoStorageLike): void {
  try {
    storage.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // ignore -- nothing left to clear if the store itself is unavailable
  }
}
