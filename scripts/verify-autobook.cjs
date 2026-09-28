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
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel, out);
      else out.push(rel);
    }
    return out;
  };
  for (const file of walk("lib/autobook")) {
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
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel, out);
      else out.push(rel);
    }
    return out;
  };
  for (const file of walk("lib/autobook")) {
    const body = read(file);
    for (const other of ["lib/watch/", "lib/reservation/", "lib/automation/", "agent/"]) {
      assert(!body.includes(`@/${other}`), `${file} 이 ${other} 를 import 한다`);
    }
  }
});

// --- 6. UI ------------------------------------------------------------------
check("화면이 공식 연동 준비 중임을 표시한다", () => {
  const panel = read("components/autobook-panel.tsx");
  assert(/공식 연동 준비 중/.test(panel), "준비 중 표시가 없다");
  assert(/결제는 사용자가 공식 앱에서 직접/.test(panel), "직접 결제 안내가 없다");
  assert(/시뮬레이션 — 실제 좌석이 아닙니다/.test(panel), "시뮬레이션 구분 문구가 없다");
  assert(!/예약 성공|좌석 확보됨/.test(panel), "아직 하지 않는 결과를 표시한다");
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
