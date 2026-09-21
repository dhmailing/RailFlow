import "server-only";

export type AuthStoreMode = "disabled" | "memory" | "postgres";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

export function getAuthStoreMode(): AuthStoreMode {
  const value = readEnv("AUTH_STORE");
  return value === "memory" || value === "postgres" ? value : "disabled";
}

// The only mode that is ever actually usable in this PR is "memory", and
// only outside production. Vercel Serverless gives every instance (and every
// cold start) its own process memory, so an in-memory account/session store
// cannot behave as a real account system in Production -- a user could sign
// up on one instance and get "logged out" on the very next request served by
// a different one. "postgres" is accepted as a *selectable* value (so this
// flag's shape doesn't need to change again once a real adapter exists) but
// is never usable yet, because no Postgres-backed AuthStore implementation
// exists in this PR (see db/postgres/ -- schema design only).
export function isAuthStoreUsable(): boolean {
  return getAuthStoreMode() === "memory" && process.env.NODE_ENV !== "production";
}
