import "server-only";

import { memoryAuthStore } from "@/lib/auth/memory-store";
import type { AuthStore } from "@/lib/auth/types";

// Single seam for swapping in a persistent (Postgres) implementation later
// without touching any route or the auth logic itself -- mirrors
// lib/reservation/provider.ts's getReservationProvider() pattern from v0.4.
export function getAuthStore(): AuthStore {
  return memoryAuthStore;
}
