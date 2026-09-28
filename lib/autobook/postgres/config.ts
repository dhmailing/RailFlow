import "server-only";

// v0.10 PostgreSQL 저장소 설정.
//
// 이 파일이 지키는 것은 하나다: **설정이 없으면 memory 로 후퇴하지 않고
// 그대로 실패한다.** 자동 후퇴는 "서버형인 줄 알았는데 프로세스가 죽으면
// 작업이 사라지는" 상태를 조용히 만들어 낸다. 그건 fail-open 이다.
//
// 연결 문자열은 이 모듈 밖으로 나가지 않는다. 반환값에도, 오류 메시지에도,
// 로그에도 담지 않는다.

export type PostgresConfigResult =
  | { ok: true; connectionString: string; source: "AUTOBOOK_DATABASE_URL" | "DATABASE_URL" }
  | { ok: false; reason: PostgresConfigProblem; message: string };

export type PostgresConfigProblem =
  | "DATABASE_URL_MISSING"
  | "DATABASE_URL_INVALID"
  | "DATABASE_URL_UNSUPPORTED_SCHEME";

/**
 * 연결 문자열을 읽는다.
 *
 * `AUTOBOOK_DATABASE_URL` 이 있으면 그것을 먼저 쓴다. 자동예약만 별도
 * 인스턴스로 분리할 수 있게 하기 위해서다. 없으면 `DATABASE_URL`.
 */
export function readPostgresConfig(env: NodeJS.ProcessEnv = process.env): PostgresConfigResult {
  const candidates: Array<{ source: "AUTOBOOK_DATABASE_URL" | "DATABASE_URL"; raw: string }> = [];
  const dedicated = (env.AUTOBOOK_DATABASE_URL ?? "").trim();
  const shared = (env.DATABASE_URL ?? "").trim();
  if (dedicated) candidates.push({ source: "AUTOBOOK_DATABASE_URL", raw: dedicated });
  else if (shared) candidates.push({ source: "DATABASE_URL", raw: shared });

  const picked = candidates[0];
  if (!picked) {
    return {
      ok: false,
      reason: "DATABASE_URL_MISSING",
      // 어떤 변수를 채워야 하는지만 말한다. 값은 언급하지 않는다.
      message: "AUTOBOOK_DATABASE_URL 또는 DATABASE_URL 이 설정되지 않았습니다.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(picked.raw);
  } catch {
    // 파싱 실패 원문에는 입력값이 그대로 들어간다. 그래서 버린다.
    return {
      ok: false,
      reason: "DATABASE_URL_INVALID",
      message: `${picked.source} 값을 URL 로 해석할 수 없습니다.`,
    };
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return {
      ok: false,
      reason: "DATABASE_URL_UNSUPPORTED_SCHEME",
      message: `${picked.source} 는 postgres:// 또는 postgresql:// 여야 합니다.`,
    };
  }

  return { ok: true, connectionString: picked.raw, source: picked.source };
}

/** 설정 여부만 알려 주는 요약. 화면·상태 API 가 쓴다(값은 담지 않는다). */
export function describePostgresConfig(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  source: string | null;
  problem: PostgresConfigProblem | null;
} {
  const result = readPostgresConfig(env);
  if (result.ok) return { configured: true, source: result.source, problem: null };
  return { configured: false, source: null, problem: result.reason };
}
