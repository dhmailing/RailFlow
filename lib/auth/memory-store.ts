import "server-only";

import { randomBytes } from "node:crypto";

import { AuthError, type AuthStore, type AuthUser, type SessionRecord } from "@/lib/auth/types";

// Process-memory only. Resets on every cold start/redeploy and is never
// shared across serverless instances -- see the AuthStore interface comment
// in types.ts. Acceptable for this PR's fail-closed, flag-gated foundation;
// never for real accounts.
const usersById = new Map<string, AuthUser & { passwordHash: string }>();
const userIdByEmail = new Map<string, string>();
const sessions = new Map<string, SessionRecord>();

function generateUserId(): string {
  return `user_${crypto.randomUUID().replace(/-/g, "")}`;
}

// 256 bits of entropy, opaque (not a signed/self-encoding token). The
// session store is the sole source of truth, which makes revocation
// (logout, account deletion, kill switch) an ordinary delete rather than a
// blocklist -- see docs/adr/0002 for why this was chosen over a stateless JWT.
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export const memoryAuthStore: AuthStore = {
  async createUser(email, passwordHash) {
    const normalized = email.trim().toLowerCase();
    if (userIdByEmail.has(normalized)) {
      throw new AuthError("EMAIL_TAKEN", "이미 가입된 이메일입니다.");
    }
    const user: AuthUser & { passwordHash: string } = {
      id: generateUserId(),
      email: normalized,
      createdAt: new Date().toISOString(),
      passwordHash,
    };
    usersById.set(user.id, user);
    userIdByEmail.set(normalized, user.id);
    return { id: user.id, email: user.email, createdAt: user.createdAt };
  },

  async findUserByEmail(email) {
    const id = userIdByEmail.get(email.trim().toLowerCase());
    if (!id) return null;
    return usersById.get(id) ?? null;
  },

  async findUserById(id) {
    const user = usersById.get(id);
    if (!user) return null;
    return { id: user.id, email: user.email, createdAt: user.createdAt };
  },

  async createSession(userId, ttlMs) {
    const now = Date.now();
    const record: SessionRecord = {
      token: generateSessionToken(),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    sessions.set(record.token, record);
    return record;
  },

  async getSession(token) {
    const record = sessions.get(token);
    if (!record) return null;
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return record;
  },

  async deleteSession(token) {
    sessions.delete(token);
  },

  async deleteAllSessionsForUser(userId) {
    for (const [token, record] of sessions) {
      if (record.userId === userId) sessions.delete(token);
    }
  },

  async deleteUser(userId) {
    const user = usersById.get(userId);
    if (user) {
      userIdByEmail.delete(user.email);
      usersById.delete(userId);
    }
    for (const [token, record] of sessions) {
      if (record.userId === userId) sessions.delete(token);
    }
  },
};

// Test-only: clears all in-memory users/sessions between independent test scenarios.
export function __resetAuthStoreForTests(): void {
  usersById.clear();
  userIdByEmail.clear();
  sessions.clear();
}
