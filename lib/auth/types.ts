import "server-only";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
};

export type AuthErrorCode =
  | "EMAIL_TAKEN"
  | "INVALID_CREDENTIALS"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "WEAK_PASSWORD";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export type SessionRecord = {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
};

// Storage boundary for the whole auth subsystem. This PR ships exactly one
// implementation (memory-store.ts) -- in process memory, lost on every cold
// start/redeploy. A real deployment needs a persistent implementation of
// this same interface (Postgres -- see db/postgres/migrations and
// docs/adr/0002) before any account created here survives past the current
// server instance. Nothing in this file talks to a database.
export interface AuthStore {
  createUser(email: string, passwordHash: string): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<(AuthUser & { passwordHash: string }) | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  createSession(userId: string, ttlMs: number): Promise<SessionRecord>;
  getSession(token: string): Promise<SessionRecord | null>;
  deleteSession(token: string): Promise<void>;
  deleteAllSessionsForUser(userId: string): Promise<void>;
  // Used by the account-deletion flow (§6 보안 요구사항: 사용자 데이터 삭제 기능).
  deleteUser(userId: string): Promise<void>;
}
