// PostgreSQL 통합 테스트용 준비 도구.
//
// **테스트 전용 DB 에만 붙는다.** 연결 문자열은 `AUTOBOOK_TEST_DATABASE_URL`
// 하나로만 받으며, 이 변수가 없으면 테스트는 실행되지 않고 NOT RUN 으로
// 남는다. 운영 DB 에 붙거나 DATABASE_URL 을 대신 쓰는 경로는 없다 --
// 테스트가 실수로 운영 데이터를 TRUNCATE 하는 일을 막기 위해서다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TEST_DB_ENV = "AUTOBOOK_TEST_DATABASE_URL";

export function testDatabaseUrl() {
  return (process.env[TEST_DB_ENV] ?? "").trim() || null;
}

/** 이 테스트가 왜 건너뛰어졌는지 한 줄로 설명한다. */
export function skipReason() {
  return `${TEST_DB_ENV} 가 설정되지 않아 PostgreSQL 통합 테스트를 실행하지 않았습니다(NOT RUN).`;
}

const MIGRATIONS = ["db/postgres/migrations/0002_autobook.sql", "db/postgres/migrations/0003_autobook_worker.sql"];

/**
 * 테스트 스키마를 만든다. migration 파일을 그대로 실행하므로, 파일이
 * 실제로 적용 가능한지도 함께 검증된다.
 */
export async function applyMigrations(pool) {
  for (const relative of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(root, relative), "utf8");
    await pool.query(sql);
  }
}

/** 매 테스트 전에 자동예약 테이블만 비운다. 다른 테이블은 건드리지 않는다. */
export async function truncateAutobookTables(pool) {
  await pool.query(
    "TRUNCATE autobook_audit, autobook_notifications, autobook_account_links, autobook_jobs RESTART IDENTITY CASCADE",
  );
}
