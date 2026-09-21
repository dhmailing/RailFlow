import "server-only";

import type { NextRequest } from "next/server";

// A single, explicit interface so a distributed limiter (Redis/Upstash,
// or a PostgreSQL-backed counter table once db/postgres is connected) can
// be swapped in later without touching any route.
export interface RateLimiter {
  isRateLimited(request: NextRequest): boolean;
}

// IMPORTANT -- this is a development/test-only limiter, not an operational
// control. It is a plain in-process Map: on Vercel each serverless
// invocation may land on a different instance (and every cold start resets
// the Map to empty), so the "limit" this enforces is per-instance, not
// per-deployment. Do not describe this as "rate limiting is implemented" in
// a PR description -- it is a best-effort development safeguard only, until
// a real distributed limiter (see the RateLimiter interface above) is
// connected.
//
// Client identification trusts `cf-connecting-ip` first, then the first hop
// of `x-forwarded-for`. This is the correct header for a Cloudflare-fronted
// deployment (ChatGPT Sites) and for a direct Vercel deployment
// respectively -- Vercel's own edge sets `x-forwarded-for` with the real
// client IP as the first entry. This assumption breaks if another proxy or
// CDN is placed in front of either deployment target without also
// forwarding/trusting the same header convention; re-derive `clientId` for
// that platform's actual header before relying on this for anything beyond
// abuse-deterrence in development.
export function createMemoryRateLimiter(limitPerMinute: number): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    isRateLimited(request: NextRequest): boolean {
      const clientId =
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "anonymous";
      const now = Date.now();
      for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
      const bucket = buckets.get(clientId);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(clientId, { count: 1, resetAt: now + 60_000 });
        return false;
      }
      bucket.count += 1;
      return bucket.count > limitPerMinute;
    },
  };
}
