import "server-only";

import { isAuthStoreUsable } from "@/lib/auth/feature-flags";
import { memoryAuthStore } from "@/lib/auth/memory-store";
import { AuthError, type AuthStore } from "@/lib/auth/types";

// Single seam for swapping in a persistent (Postgres) implementation later
// without touching any route or the auth logic itself -- mirrors
// lib/reservation/provider.ts's getReservationProvider() pattern from v0.4.
//
// Fail-closed: throws instead of ever returning the in-memory store when it
// isn't usable (production, or AUTH_STORE=disabled) -- see
// lib/auth/feature-flags.ts for why Vercel Serverless makes the memory store
// unusable as a real account system.
export function getAuthStore(): AuthStore {
  if (!isAuthStoreUsable()) {
    throw new AuthError(
      "AUTH_STORE_DISABLED",
      "계정 저장소가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.",
    );
  }
  return memoryAuthStore;
}
