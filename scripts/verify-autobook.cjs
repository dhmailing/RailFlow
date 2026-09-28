#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- 다른 verify-*.cjs 와 같은 CommonJS 스크립트다. */
// v0.9 서버형 자동예약 안전장치 검사.
//
// 소스 검사만 한다. 네트워크에 나가지 않고 브라우저도 띄우지 않는다.
// 여기 통과한다고 실제 연동이 검증된 것은 아니다 -- 실제 Provider 는
// 아직 Stub 이다.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const failures = [];
const checks = [];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function check(name, fn) {
  try {
    fn();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 디렉터리 안의 파일 경로를 전부 모은다. */
function walkDir(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(rel, out);
    else out.push(rel);
  }
  return out;
}

// --- 1. fail-closed 기본값 --------------------------------------------------
check("Provider 기본값이 unavailable 이다", () => {
  const flags = strip(read("lib/autobook/feature-flags.ts"));
  assert(/return "unavailable";/.test(flags), "기본값이 unavailable 이 아니다");
  assert(/isProduction\(\)/.test(flags), "운영 환경을 구분하지 않는다");
  assert(/value === "mock-server" && !isProduction\(\)/.test(flags), "운영에서 Mock 이 막히지 않는다");
});

check("강제 중단 스위치가 모든 것보다 우선한다", () => {
  const flags = strip(read("lib/autobook/feature-flags.ts"));
  for (const fn of ["getAutobookProviderFlag", "getAutobookStoreMode", "isAutobookEnabled"]) {
    const body = flags.split(`export function ${fn}`)[1].split("\n}")[0];
    assert(/isKillSwitchOn\(\)/.test(body), `${fn} 이 kill switch 를 보지 않는다`);
  }
});

check("실제 예약 가능 표시가 켜져 있지 않다", () => {
  const flags = strip(read("lib/autobook/feature-flags.ts"));
  assert(/liveReservationPossible: false/.test(flags), "실제 예약이 가능하다고 표시한다");
});

// --- 2. 예약 안전 규칙 ------------------------------------------------------
check("예약 요청 뒤에 재시도로 돌아가는 전이가 없다", () => {
  const machine = strip(read("lib/autobook/state-machine.ts"));
  const row = machine.split("RESERVATION_CLAIMING: [")[1].split("]")[0];
  assert(!/SEAT_FOUND/.test(row), "예약 요청 뒤 SEAT_FOUND 로 돌아간다");
  assert(/AMBIGUOUS_RESULT/.test(row), "불명확 상태로 갈 수 없다");
  assert(/POST_REQUEST_STATUSES/.test(machine), "요청 이후 상태 목록이 없다");
});

check("불명확한 결과는 재예약 없이 예약내역으로 확정한다", () => {
  const worker = strip(read("lib/autobook/worker.ts"));
  const block = worker.split('case "AMBIGUOUS": {')[1].split('case "AUTH_REQUIRED"')[0];
  assert(/findExistingReservation/.test(block), "예약내역 재조회가 없다");
  assert(!/createReservation/.test(block), "불명확한 결과에서 재예약을 시도한다");
  assert(/AMBIGUOUS_RESULT/.test(block), "확정 실패 시 멈추지 않는다");
});

check("예약 요청 직전에 claim 을 갱신한다", () => {
  const worker = strip(read("lib/autobook/worker.ts"));
  const renew = worker.indexOf("renewClaim");
  const create = worker.indexOf("provider.createReservation");
  assert(renew > -1 && renew < create, "예약 요청 전에 claim 을 확인하지 않는다");
});

check("예약 요청에 멱등키가 전달된다", () => {
  const worker = strip(read("lib/autobook/worker.ts"));
  assert(/idempotencyKey: job\.reservationIdempotencyKey/.test(worker), "멱등키를 넘기지 않는다");
});

check("결과를 재확인할 수 없는 Provider 로는 예약하지 않는다", () => {
  const worker = strip(read("lib/autobook/worker.ts"));
  assert(/!capabilities\.canVerifyReservation/.test(worker), "재확인 능력을 보지 않는다");
});

check("좌석 확보 후 나머지 후보를 중단한다", () => {
  const worker = strip(read("lib/autobook/worker.ts"));
  assert((worker.match(/stopOtherCandidates/g) ?? []).length >= 3, "확보 경로 모두에서 중단하지 않는다");
});

check("UNKNOWN 을 매진으로 처리하지 않는다", () => {
  const worker = strip(read("lib/autobook/worker.ts"));
  const unknown = worker.split("function mapUnknownReason")[1];
  assert(!/SOLD_OUT/.test(unknown), "UNKNOWN 을 매진으로 매핑한다");
  const loop = worker.split("for (const candidate of candidates)")[1].split("if (!found)")[0];
  assert(/availability\.kind === "SOLD_OUT"/.test(loop), "매진 판정이 명시적이지 않다");
});

check("운영자 차단은 종료 상태이고 우회하지 않는다", () => {
  const machine = strip(read("lib/autobook/state-machine.ts"));
  const row = machine.split("BLOCKED_BY_OPERATOR: [")[1].split("]")[0];
  assert(row.trim() === "", "운영자 차단에서 빠져나가는 전이가 있다");
  const worker = strip(read("lib/autobook/worker.ts"));
  assert(!/retry[\s\S]{0,40}BLOCKED_BY_OPERATOR/i.test(worker), "차단 후 재시도한다");
});

// --- 3. 동시성 -------------------------------------------------------------
check("쓰기가 fencing token 을 거친다", () => {
  const store = strip(read("lib/autobook/store.ts"));
  assert(/fencingToken/.test(store), "계약에 fencing token 이 없다");
  const memory = strip(read("lib/autobook/memory-store.ts"));
  const update = memory.split("async updateJob(")[1].split("async releaseClaim")[0];
  assert(/assertFresh/.test(update), "쓰기에서 토큰을 확인하지 않는다");
  const claim = memory.split("async claimNext(")[1].split("async renewClaim")[0];
  assert(/lastToken/.test(claim), "토큰이 단조 증가하지 않는다");
  assert(!/await /.test(claim), "claim 구간에 await 가 있어 원자적이지 않다");
});

check("Postgres 스키마가 같은 계약을 설계에 담고 있다", () => {
  const sql = read("db/postgres/migrations/0002_autobook.sql");
  assert(/FOR UPDATE SKIP LOCKED/.test(sql), "원자적 claim 설계가 없다");
  assert(/claim_fencing_token/.test(sql), "fencing token 컬럼이 없다");
  assert(/autobook_jobs_active_dedupe/.test(sql), "중복 방지 인덱스가 없다");
  assert(/idempotency_key\s+TEXT NOT NULL UNIQUE/.test(sql), "알림 멱등키 제약이 없다");
  assert(!/password/i.test(sql), "스키마에 비밀번호 컬럼이 있다");
});

// --- 4. 자격증명 보호 -------------------------------------------------------
check("코레일 계정 비밀번호를 받는 통로가 없다", () => {
  const link = strip(read("lib/autobook/account-link.ts"));
  assert(!/password|passwd|pwd/i.test(link), "비밀번호를 다루는 코드가 있다");
  assert(/ACCOUNT_LINK_REQUIRED/.test(link), "연결 거부 코드가 없다");
  const methods = link.split("METHOD_AVAILABILITY")[1].split("});")[0];
  assert(!/available: true/.test(methods), "연결 방식이 이미 활성화돼 있다");
});

check("서버형 자동예약 경로에 로그 출력이 없다", () => {
  // 자격증명·쿠키·토큰이 로그로 새는 가장 흔한 경로가 console 이다.
  // 이 PR 범위에서는 아예 쓰지 않는 것으로 막는다.
  for (const file of walkDir("lib/autobook")) {
    const body = strip(read(file));
    assert(!/console\.[a-z]+\(/.test(body), `로그 출력이 있다: ${file}`);
  }
});

check("알림에 자격증명·세션이 들어가지 않는다", () => {
  const outbox = strip(read("lib/autobook/outbox.ts"));
  const payload = outbox.split("payload: {")[1].split("},")[0];
  for (const word of ["password", "cookie", "token", "session", "reservationRef"]) {
    assert(!payload.includes(word), `알림 payload 에 ${word} 가 있다`);
  }
});

// --- 5. 시뮬레이션 구분 -----------------------------------------------------
check("Mock Provider 가 스스로를 시뮬레이션이라고 밝힌다", () => {
  const mock = strip(read("lib/autobook/providers/mock-server.ts"));
  assert(/simulation: true/.test(mock), "Mock 이 시뮬레이션임을 밝히지 않는다");
  assert(/SIM-/.test(mock), "시뮬레이션 예약번호가 구분되지 않는다");
  const unavailable = strip(read("lib/autobook/providers/unavailable.ts"));
  assert(/simulation: false/.test(unavailable), "unavailable 이 시뮬레이션으로 표시된다");
});

check("공식 Provider 는 Stub 이고 추측한 endpoint 가 없다", () => {
  const stub = read("lib/autobook/providers/official-approved-stub.ts");
  assert(/OFFICIAL_INTEGRATION_REQUIRED/.test(stub), "미구현을 알리지 않는다");
  const body = strip(stub);
  assert(!/https?:\/\//.test(body), "Stub 에 외부 주소가 있다");
  assert(!/fetch\(/.test(body), "Stub 이 요청을 보낸다");
  for (const flag of ["canReadAvailability: false", "canCreateReservation: false", "canVerifyReservation: false"]) {
    assert(body.includes(flag), `Stub 의 ${flag} 가 아니다`);
  }
});

check("lib/autobook 어디에도 철도 사이트 주소가 없다", () => {
  for (const file of walkDir("lib/autobook")) {
    const body = strip(read(file));
    // 문서 파일명(V0.9-KORAIL-...)이 아니라 실제 호스트·URL 만 잡는다.
    assert(
      !/(https?:\/\/|\/\/)?[a-z0-9.-]*\.(srail|korail|letskorail)\.(kr|com|co\.kr)/i.test(body),
      `철도 사이트 주소가 있다: ${file}`,
    );
    assert(!/fetch\(/.test(body), `외부 요청 코드가 있다: ${file}`);
  }
});

check("기존 모듈을 가져다 쓰지 않는다(회귀 방지)", () => {
  for (const file of walkDir("lib/autobook")) {
    const body = read(file);
    for (const other of ["lib/watch/", "lib/reservation/", "lib/automation/", "agent/"]) {
      assert(!body.includes(`@/${other}`), `${file} 이 ${other} 를 import 한다`);
    }
  }
});

// --- 5-1. 폐기된 브라우저 Agent 경계 (§4 회귀 방지) ----------------------
//
// 이 절이 있는 이유: 폐기 결정(docs/adr/0003-abandon-browser-agent.md)을
// 문서에만 적어 두면 다음 작업에서 cherry-pick 한 줄로 되살아난다. 경로·토큰·
// import 를 코드에서 막는다.

const FORBIDDEN_PATHS = ["agent", "lib/live", "tests/agent"];

check("폐기된 Agent 경로가 저장소에 없다", () => {
  for (const rel of FORBIDDEN_PATHS) {
    assert(!fs.existsSync(path.join(ROOT, rel)), `폐기된 경로가 있다: ${rel}/`);
  }
});

/** 저장소 전체(빌드 산출물·의존성 제외)를 훑는다. */
function repoFiles(dir = ".", out = []) {
  const SKIP = new Set([
    ".git",
    "node_modules",
    ".next",
    ".vercel",
    "dist",
    "build",
    "playwright-report",
    "test-results",
    "coverage",
  ]);
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const rel = dir === "." ? entry.name : path.join(dir, entry.name);
    if (entry.isDirectory()) repoFiles(rel, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md|css|yml|yaml|cmd|ps1|sh|bat)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

check("폐기된 Agent 토큰이 저장소에 없다", () => {
  // 이 스크립트 자체는 토큰을 문자열로 갖고 있으므로 제외한다.
  const SELF = "scripts/verify-autobook.cjs";
  const FORBIDDEN_TOKENS = [
    "etk.srail.kr",
    "openBookingSite",
    "LIVE_READ_ONLY",
    "PAIRING_REQUIRED",
    "DEPRECATED_BLOCKED",
    "deprecation.mjs",
    "agent-protocol",
    "RAILFLOW_AGENT",
    "127.0.0.1:4319",
    "localhost:4319",
    "@/lib/live",
    "chromium.connectOverCDP",
  ];
  for (const file of repoFiles()) {
    if (file === SELF) continue;
    const body = read(file);
    for (const token of FORBIDDEN_TOKENS) {
      assert(!body.includes(token), `폐기된 Agent 토큰이 있다: ${file} → ${token}`);
    }
  }
});

check("서버형 자동예약에 브라우저 자동화가 없다", () => {
  // main 에는 v0.7 부터 `lib/automation/providers/mock-browser-provider.ts` 가
  // 있다. 그것은 RailFlow **자체 데모 화면**(/demo/booking-simulator)만 띄우며
  // 공식 예매 화면에 접근하지 않는다. 그래서 저장소 전체에서 브라우저 구동을
  // 금지하지는 않고, v0.9 서버형 경로에 브라우저가 끼어들지 못하게 막는다.
  for (const file of [...walkDir("lib/autobook"), "components/autobook-panel.tsx", "app/api/autobook/status/route.ts"]) {
    const body = read(file);
    for (const token of ["chromium", "playwright", "puppeteer", "webdriver", "page.goto", "browser.newPage"]) {
      assert(!body.includes(token), `서버형 자동예약 경로에 브라우저 자동화가 있다: ${file} → ${token}`);
    }
  }
});

check("실사이트 브라우저 자동화 의존성·스크립트가 없다", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // playwright / @playwright/test 는 RailFlow **자체 화면** E2E 용으로 main
  // 이전부터 있던 의존성이다. 문제가 되는 것은 탐지 회피용 래퍼와, 공식
  // 예매 화면을 띄우는 코드다(위 토큰 검사가 chromium.launch 를 막는다).
  for (const name of ["playwright-extra", "playwright-core", "puppeteer", "puppeteer-extra", "rebrowser-playwright"]) {
    assert(!(name in deps), `실사이트 자동화 의존성이 있다: ${name}`);
  }
  const scripts = JSON.stringify(pkg.scripts ?? {});
  for (const token of ["agent", "live"]) {
    assert(!scripts.includes(token), `package.json scripts 에 ${token} 관련 항목이 있다`);
  }
});

check("lib/autobook 이 Agent·live·automation 을 import 하지 않는다", () => {
  for (const file of walkDir("lib/autobook")) {
    const body = read(file);
    for (const other of ["agent/", "lib/live/", "lib/automation/"]) {
      assert(!body.includes(`@/${other}`), `${file} 이 ${other} 를 import 한다`);
      assert(!new RegExp(`from\\s+["'][./]+.*${other.replace("/", "\\/")}`).test(body), `${file} 이 ${other} 를 상대경로로 import 한다`);
    }
  }
});

// --- 5-2. v0.10 PostgreSQL 저장소와 Worker 실행 기반 ----------------------

check("SQL 값이 전부 파라미터 바인딩이다", () => {
  const source = strip(read("lib/autobook/postgres-store.ts"));
  // 템플릿 리터럴 안에서 ${...} 로 값을 끼워 넣은 곳이 없어야 한다.
  // 예외는 컬럼 목록 상수(JOB_COLUMNS)와 미리 정한 SET 절 조립뿐이다.
  const allowed = new Set(["JOB_COLUMNS", "sets.join(\", \")", "[...sets, \"updated_at = NOW()\"].join(\", \")"]);
  const interpolations = source.match(/\$\{[^}]*\}/g) ?? [];
  for (const raw of interpolations) {
    const inner = raw.slice(2, -1).trim();
    if (allowed.has(inner)) continue;
    // `$${index}` 형태(플레이스홀더 번호)와 컬럼 목록 가공은 값이 아니다.
    if (/^index$/.test(inner)) continue;
    if (/^JOB_COLUMNS\b/.test(inner)) continue;
    if (/^c\.trim\(\)$/.test(inner)) continue;
    if (/^column$/.test(inner)) continue;
    throw new Error(`SQL 문자열에 값이 끼워 넣어졌을 수 있다: ${raw}`);
  }
  // 파라미터를 실제로 쓰는지도 확인한다.
  assert(/\$1/.test(source), "바인딩 파라미터를 쓰지 않는다");
  assert(/FOR UPDATE SKIP LOCKED/.test(source), "원자적 claim 이 없다");
  // 파일 전체에서 토큰 문자열을 찾으면, 한 함수에서 빠져도 다른 함수가
  // 대신 만족시켜 검사가 비어 버린다. claim 을 다루는 함수마다 따로 본다.
  for (const fn of ["updateJob", "renewClaim", "releaseClaim"]) {
    const body = source.split(`async ${fn}(`)[1];
    assert(body !== undefined, `${fn} 이 없다`);
    const statement = body.split("},")[0];
    assert(
      /claim_worker_id = \$2/.test(statement) && /claim_fencing_token = \$3/.test(statement),
      `${fn} 이 fencing token 으로 쓰기를 막지 않는다`,
    );
  }
});

check("DB 오류 원문이 밖으로 나가지 않는다", () => {
  const client = strip(read("lib/autobook/postgres/client.ts"));
  const redact = client.split("export function redactDbError")[1].split("\n}")[0];
  assert(!/error\.message|source\.message/.test(redact), "오류 원문 message 를 통과시킨다");
  assert(/safeMessage/.test(redact), "줄인 메시지를 만들지 않는다");

  const store = strip(read("lib/autobook/postgres-store.ts"));
  assert(/toStoreError\(error\)/.test(store), "쿼리 오류를 그대로 던진다");
});

check("연결 문자열이 상태·화면·오류로 새지 않는다", () => {
  const config = strip(read("lib/autobook/postgres/config.ts"));
  const describe = config.split("export function describePostgresConfig")[1];
  assert(!/connectionString/.test(describe), "상태 요약이 연결 문자열을 담는다");

  const route = strip(read("app/api/autobook/status/route.ts"));
  assert(!/connectionString|DATABASE_URL\s*\)/.test(route), "상태 API 가 연결 문자열을 담는다");

  const panel = read("components/autobook-panel.tsx");
  assert(!/connectionString/.test(panel), "화면이 연결 문자열을 담는다");
});

check("DB 설정이 없으면 memory 로 후퇴하지 않는다", () => {
  const selector = strip(read("lib/autobook/store-selector.ts"));
  const postgresBranch = selector.split("const config = readPostgresConfig();")[1];
  assert(postgresBranch !== undefined, "postgres 분기가 없다");
  assert(!/createMemoryAutobookStore/.test(postgresBranch), "설정 실패 시 memory 로 후퇴한다");
  assert(/unavailableStore/.test(postgresBranch), "설정 실패 시 실패한 저장소를 돌려주지 않는다");

  const flags = strip(read("lib/autobook/feature-flags.ts"));
  assert(/isPostgresStoreConfigured\(\)/.test(flags), "postgres 사용 가능 여부가 설정을 보지 않는다");
});

check("Production 에서 memory 저장소가 계속 금지된다", () => {
  const selector = strip(read("lib/autobook/store-selector.ts"));
  assert(/isAutobookStoreUsable\(\)/.test(selector), "memory 분기가 운영 금지 판정을 보지 않는다");
  const flags = strip(read("lib/autobook/feature-flags.ts"));
  assert(/mode === "memory"\) return !isProduction\(\)/.test(flags), "운영에서 memory 가 허용된다");
});

check("Worker 실행 진입점이 HTTP 로 열려 있지 않다", () => {
  const entry = read("lib/autobook/worker-entry.ts");
  assert(/import "server-only"/.test(entry), "서버 전용 표시가 없다");
  assert(!/NextResponse|export async function (GET|POST|PUT|PATCH|DELETE)/.test(entry), "HTTP 핸들러가 있다");
  // 라우트 어디에서도 Worker 진입점을 부르지 않는다.
  const walkApp = walkDir("app").filter((file) => /route\.(ts|tsx)$/.test(file));
  for (const route of walkApp) {
    assert(!read(route).includes("worker-entry"), `라우트가 Worker 를 실행한다: ${route}`);
  }
});

check("Worker 가 중단 조건을 순서대로 본다", () => {
  const entry = strip(read("lib/autobook/worker-entry.ts"));
  const kill = entry.indexOf("isKillSwitchOn()");
  const enabled = entry.indexOf("isAutobookEnabled()");
  const store = entry.indexOf("resolveAutobookStore()");
  const capability = entry.indexOf("canReadAvailability");
  const loop = entry.indexOf("runOnce(");
  assert(kill > -1 && kill < enabled, "kill switch 가 가장 먼저가 아니다");
  assert(enabled < store, "기능 스위치보다 저장소를 먼저 연다");
  assert(store < capability, "Provider 능력보다 저장소를 늦게 본다");
  assert(capability < loop, "능력 확인 전에 작업을 진행한다");
  assert(/getWorkerBatchSize\(\)/.test(entry), "배치 상한을 보지 않는다");
});

check("Worker 배치 상한이 5를 넘지 않는다", () => {
  const flags = strip(read("lib/autobook/feature-flags.ts"));
  const body = flags.split("export function getWorkerBatchSize")[1].split("\n}")[0];
  assert(/Math\.min\([\s\S]*?,\s*5\s*\)/.test(body), "배치 상한이 5가 아니다");
});

check("Migration 이 반복 실행에 안전하다", () => {
  const sql = read("db/postgres/migrations/0003_autobook_worker.sql");
  const statements = sql
    .split(";")
    .map((part) => part.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);
  for (const statement of statements) {
    const safe =
      /^ALTER TABLE[\s\S]*ADD COLUMN IF NOT EXISTS/i.test(statement) ||
      /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(statement) ||
      /^DROP INDEX IF EXISTS/i.test(statement);
    assert(safe, `반복 실행에 안전하지 않은 구문이 있다: ${statement.slice(0, 60)}`);
  }
  // 되돌릴 수 없는 파괴적 구문이 없어야 한다.
  assert(!/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i.test(sql), "파괴적 migration 구문이 있다");
});

check("예약·알림 멱등키가 DB 제약으로 강제된다", () => {
  const sql = read("db/postgres/migrations/0003_autobook_worker.sql");
  assert(/autobook_jobs_reservation_idem/.test(sql), "예약 멱등키 UNIQUE 인덱스가 없다");
  const base = read("db/postgres/migrations/0002_autobook.sql");
  assert(/idempotency_key\s+TEXT NOT NULL UNIQUE/.test(base), "알림 멱등키 제약이 없다");
});

check("claim 가능 상태를 두 저장소가 함께 본다", () => {
  const machine = strip(read("lib/autobook/state-machine.ts"));
  assert(/export const CLAIMABLE_STATUSES/.test(machine), "공유 목록이 없다");
  const list = machine.split("CLAIMABLE_STATUSES")[1].split("]")[0];
  assert(!/RESERVATION_CLAIMING/.test(list), "예약 요청을 보낸 작업을 다시 집는다");
  assert(!/"DRAFT"/.test(list), "작성 중 작업을 집는다");

  const memory = strip(read("lib/autobook/memory-store.ts"));
  assert(/isClaimableStatus\(job\.status\)/.test(memory), "메모리 저장소가 공유 목록을 쓰지 않는다");
  const postgres = strip(read("lib/autobook/postgres-store.ts"));
  assert(/CLAIMABLE_STATUSES/.test(postgres), "PostgreSQL 저장소가 공유 목록을 쓰지 않는다");
});

check("Node 전용 드라이버를 정적으로 import 하지 않는다", () => {
  for (const file of walkDir("lib/autobook")) {
    const body = strip(read(file));
    assert(!/^import\s[^\n]*from\s+["']pg["']/m.test(body), `pg 를 정적 import 한다: ${file}`);
  }
  const client = strip(read("lib/autobook/postgres/client.ts"));
  assert(/await import\("pg"\)/.test(client), "드라이버를 지연 로드하지 않는다");
  const vite = read("vite.config.ts");
  assert(/"pg"/.test(vite), "Workers 빌드에서 pg 를 external 로 빼지 않는다");
});

check("감사 기록에 자격증명·사용자 원문이 들어가지 않는다", () => {
  const audit = strip(read("lib/autobook/audit.ts"));
  assert(/createHash\("sha256"\)/.test(audit), "사용자 식별자를 단방향 해시하지 않는다");
  assert(/FORBIDDEN/.test(audit), "감사 detail 금지어 검사가 없다");
  const entry = strip(read("lib/autobook/worker-entry.ts"));
  assert(/auditPseudonym\(/.test(entry), "감사 기록에 가명을 쓰지 않는다");
  assert(!/userPseudonym: job\?\.userId|userPseudonym: job\.userId/.test(entry), "사용자 식별자 원문을 기록한다");
  assert(/safeAuditDetail\(/.test(entry), "감사 detail 을 거르지 않는다");
});

check("테스트가 운영 DB 를 가리키지 못한다", () => {
  const harness = read("tests/autobook/pg-harness.mjs");
  assert(/AUTOBOOK_TEST_DATABASE_URL/.test(harness), "테스트 전용 변수를 쓰지 않는다");
  assert(!/process\.env\.DATABASE_URL/.test(harness), "테스트가 운영 연결 문자열을 읽는다");
  const spec = read("tests/autobook/postgres-store.conformance.test.mjs");
  assert(/skip/.test(spec), "설정이 없을 때 NOT RUN 으로 남기지 않는다");
});

// --- 6. UI ------------------------------------------------------------------
check("화면이 공식 연동 준비 중임을 표시한다", () => {
  const panel = read("components/autobook-panel.tsx");
  assert(/공식 연동 준비 중/.test(panel), "준비 중 표시가 없다");
  assert(/결제는 사용자가 공식 앱에서 직접/.test(panel), "직접 결제 안내가 없다");
  assert(/시뮬레이션 — 실제 좌석이 아닙니다/.test(panel), "시뮬레이션 구분 문구가 없다");
  assert(!/예약 성공|좌석 확보됨/.test(panel), "아직 하지 않는 결과를 표시한다");
});

check("화면이 상태 네 가지를 그대로 표시한다", () => {
  const panel = read("components/autobook-panel.tsx");
  for (const label of [
    "서버형 자동예약 기반 준비됨",
    "실제 좌석 Provider 미연결",
    "계정 연결 비활성",
    "실제 좌석 조회·예약을 수행하지 않음",
  ]) {
    assert(panel.includes(label), `상태 표시가 없다: ${label}`);
  }
});

check("실제 작업 등록 버튼이 비활성이고 사유 세 가지를 밝힌다", () => {
  const panel = read("components/autobook-panel.tsx");
  const button = panel.split('data-testid="autobook-create-job"')[1];
  assert(button !== undefined, "등록 버튼이 없다");
  assert(/^[\s\S]{0,400}?\bdisabled\b/.test(button), "등록 버튼이 비활성이 아니다");
  assert(!/onClick/.test(button.split("</button>")[0]), "비활성 버튼에 동작이 붙어 있다");
  // §8 이 요구하는 최소 세 가지. DB 연결 상태는 별도 줄로 함께 표시한다.
  for (const reason of [
    "공식 연동 Provider 없음",
    "계정 연결 방식 없음",
    "Worker 운영 배포·스케줄 미설정",
    "영속 DB 미연결",
  ]) {
    assert(panel.includes(reason), `비활성 사유가 없다: ${reason}`);
  }
});

check("작업 생성 API 가 없다", () => {
  const apiDir = path.join(ROOT, "app/api/autobook");
  const routes = walkDir("app/api/autobook").filter((f) => /route\.(ts|tsx)$/.test(f));
  assert(fs.existsSync(apiDir), "자동예약 API 디렉터리가 없다");
  for (const route of routes) {
    const body = read(route);
    assert(
      !/export async function (POST|PUT|PATCH|DELETE)/.test(body),
      `쓰기 가능한 자동예약 API 가 있다: ${route}`,
    );
  }
  assert(routes.length === 1, `상태 조회 외의 자동예약 라우트가 있다: ${routes.join(", ")}`);
});

check("상태 API 가 읽기 전용이다", () => {
  const route = read("app/api/autobook/status/route.ts");
  assert(/export async function GET/.test(route), "GET 이 없다");
  assert(!/export async function (POST|PUT|DELETE|PATCH)/.test(route), "상태 변경 메서드가 있다");
});

// --- 결과 -------------------------------------------------------------------
const result = {
  result: failures.length === 0 ? "PASS" : "FAIL",
  passed: checks.length,
  failed: failures.length,
  networkCalls: 0,
  note: "소스 검사만 수행한다. 실제 연동 검증이 아니다(공식 Provider 는 Stub).",
};
if (failures.length > 0) result.failures = failures;
console.log(JSON.stringify(result));
process.exit(failures.length === 0 ? 0 : 1);
