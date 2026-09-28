import "server-only";

import { createHash } from "node:crypto";

// 감사 기록의 사용자 가명.
//
// 감사로그는 "중복 예약이 났다면 어느 Worker 가 어떤 토큰으로 무엇을 했는가"를
// 재구성하기 위한 것이다. 그 목적에 **사용자 식별자 원문은 필요 없다.**
//
// 같은 사용자는 같은 가명이 되어야 사건을 이어 볼 수 있고, 가명에서 원래
// 식별자를 되돌릴 수는 없어야 한다. 그래서 단방향 해시에 배포별 salt 를 쓴다.
// salt 가 없으면 고정 salt 로 떨어지는데, 그 경우에도 원문은 남지 않는다.

const FALLBACK_SALT = "railflow-autobook-audit";

export function auditPseudonym(userId: string, env: NodeJS.ProcessEnv = process.env): string {
  const salt = (env.AUTOBOOK_AUDIT_SALT ?? "").trim() || FALLBACK_SALT;
  return createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 32);
}

/**
 * 감사 detail 에 남길 수 있는 문구인지 거른다.
 *
 * Worker 의 statusDetail 에는 Provider 가 준 문구가 들어올 수 있다. 그것이
 * 자격증명·쿠키·토큰을 담고 있을 가능성을 0으로 만들 수는 없으므로, 감사
 * 기록에는 **미리 정한 사건 이름과 상태 전이만** 남기고 자유 문구는 길이를
 * 자른 뒤 금지어가 있으면 통째로 버린다.
 */
const FORBIDDEN = ["password", "passwd", "cookie", "session=", "token=", "authorization", "otp", "bearer "];

export function safeAuditDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const lowered = detail.toLowerCase();
  if (FORBIDDEN.some((word) => lowered.includes(word))) return "[redacted]";
  return detail.slice(0, 200);
}
