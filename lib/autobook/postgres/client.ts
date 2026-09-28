import "server-only";

import { AutobookError } from "@/lib/autobook/types";
import { readPostgresConfig } from "@/lib/autobook/postgres/config";

// Node 전용 PostgreSQL 드라이버 경계.
//
// `pg` 는 Node.js 전용이다. 이 저장소의 웹 빌드는 Cloudflare Workers/workerd
// 를 대상으로 하므로, 드라이버를 정적으로 import 하면 **기본 fail-closed
// 상태의 빌드까지 깨진다** — v0.7 에서 다른 Node 전용 패키지로 똑같이 겪었다
// (docs/V0.7-AUTOMATION-BOUNDARY.md §5).
//
// 그래서 여기서만 `await import("pg")` 로 **지연 로드**한다. 이 함수는
// AUTOBOOK_STORE=postgres 이고 설정이 갖춰졌을 때만 호출된다. 기본값에서는
// 드라이버가 로드되지도 않는다. vite.config.ts 가 `pg` 를 external 로 빼는
// 것은 번들러가 정적 분석으로 이 경로를 끌어오지 못하게 하는 보강이다.

export type SqlValue = string | number | boolean | null | Date | object;

export interface PgQueryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly SqlValue[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

type PgModule = {
  Pool: new (config: { connectionString: string; max?: number; connectionTimeoutMillis?: number }) => PgPoolLike;
};

let pool: PgPoolLike | null = null;
let poolKey: string | null = null;

/**
 * DB 오류를 사용자·로그에 내보낼 수 있는 형태로 줄인다.
 *
 * `pg` 의 오류는 연결 문자열, 호스트, 사용자명, 때로는 실패한 SQL 의
 * 파라미터까지 메시지에 담는다. 그대로 흘리면 자격증명과 개인정보가
 * 로그로 샌다. 여기서 **SQLSTATE 코드와 제약 이름만** 남긴다.
 */
export function redactDbError(error: unknown): { code: string | null; constraint: string | null; safeMessage: string } {
  const source = (error ?? {}) as { code?: unknown; constraint?: unknown };
  const code = typeof source.code === "string" ? source.code : null;
  const constraint = typeof source.constraint === "string" ? source.constraint : null;
  // 원문 message 를 절대 통과시키지 않는다.
  const safeMessage = `데이터베이스 오류(code=${code ?? "unknown"}${constraint ? `, constraint=${constraint}` : ""})`;
  return { code, constraint, safeMessage };
}

/** 드라이버·연결 오류를 AutobookError 로 바꾼다. 원문은 버린다. */
export function toStoreError(error: unknown): AutobookError {
  if (error instanceof AutobookError) return error;
  const { safeMessage } = redactDbError(error);
  return new AutobookError("STORE_UNAVAILABLE", safeMessage);
}

/**
 * Pool 을 얻는다. 설정이 없으면 만들지 않고 실패한다(memory 후퇴 없음).
 */
export async function getPostgresPool(): Promise<PgPoolLike> {
  const config = readPostgresConfig();
  if (!config.ok) {
    throw new AutobookError("STORE_UNAVAILABLE", config.message);
  }

  // 같은 연결 문자열이면 Pool 을 재사용한다. 키에는 문자열 자체를 쓰지만
  // 이 값은 모듈 밖으로 나가지 않는다.
  if (pool && poolKey === config.connectionString) return pool;
  if (pool) await closePostgresPool();

  let driver: PgModule;
  try {
    // 지연 로드. 기본 fail-closed 경로에서는 이 줄에 도달하지 않는다.
    driver = (await import("pg")) as unknown as PgModule;
  } catch (error) {
    const { safeMessage } = redactDbError(error);
    throw new AutobookError(
      "STORE_UNAVAILABLE",
      `PostgreSQL 드라이버를 불러오지 못했습니다. Node.js 런타임에서만 동작합니다(${safeMessage}).`,
    );
  }

  const created = new driver.Pool({
    connectionString: config.connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
  });
  pool = created;
  poolKey = config.connectionString;
  return created;
}

/** 테스트·종료 정리용. */
export async function closePostgresPool(): Promise<void> {
  const current = pool;
  pool = null;
  poolKey = null;
  if (!current) return;
  try {
    await current.end();
  } catch {
    // 종료 실패는 삼킨다. 원문에 연결 정보가 들어 있을 수 있다.
  }
}

/**
 * 연결이 실제로 되는지 확인한다. 화면이 "설정됨"과 "연결됨"을 구분해
 * 표시하기 위한 것이다.
 */
export async function checkPostgresConnection(): Promise<{ ok: boolean; problem: string | null }> {
  try {
    const active = await getPostgresPool();
    await active.query("SELECT 1");
    return { ok: true, problem: null };
  } catch (error) {
    if (error instanceof AutobookError) return { ok: false, problem: error.code };
    return { ok: false, problem: redactDbError(error).code ?? "UNKNOWN" };
  }
}
