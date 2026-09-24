#!/usr/bin/env node
// v0.8 Local Automation Agent 안전장치 검사.
//
// 다른 verify-*.cjs 와 같은 역할이다: "문서에 적어 둔 약속"이 실제로 코드에서
// 지켜지는지를 소스 검사로 확인한다. 브라우저를 띄우지 않고, 네트워크에
// 나가지 않는다.
//
// 여기서 통과한다고 실제 사이트 연동이 검증된 것은 아니다. 그건 사용자의
// PC에서 LIVE_READ_ONLY 로 직접 확인해야 한다.

/* eslint-disable @typescript-eslint/no-require-imports -- 다른 verify-*.cjs 와 같은 CommonJS 스크립트다. */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const failures = [];
const checks = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}

// 주석은 검사 대상이 아니다. 주석에는 "0.0.0.0 으로 열지 않는다" 처럼
// 금지 대상을 설명하는 문장이 들어가기 때문이다.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

const agentFiles = listFiles("agent").filter((f) => f.endsWith(".mjs"));
const agentSource = agentFiles.map(read).join("\n");
const agentCode = stripComments(agentSource);

// --- 1. 자격증명·세션을 다루지 않는다 ---------------------------------------
check("아이디/비밀번호/OTP 입력 코드가 없다", () => {
  const banned = [
    /\.fill\(\s*[^)]*password/i,
    /type\s*=\s*["']password["']/i,
    /getByLabel\(\s*["'][^"']*비밀번호/,
    /\botp\s*[:=]/i,
  ];
  for (const pattern of banned) {
    assert(!pattern.test(agentCode), `금지된 패턴이 있다: ${pattern}`);
  }
});

check("쿠키·세션을 파일로 내보내지 않는다", () => {
  for (const pattern of [/storageState/, /\.cookies\s*\(/, /addCookies/, /setCookie/]) {
    assert(!pattern.test(agentCode), `쿠키/세션 추출 코드가 있다: ${pattern}`);
  }
});

check("브라우저는 항상 화면이 보이는 모드로 뜬다", () => {
  assert(!/headless:\s*true/.test(agentCode), "headless: true 가 있다");
  const launches = agentCode.match(/launchPersistentContext\([\s\S]{0,300}?\)/g) ?? [];
  assert(launches.length > 0, "브라우저 실행 코드를 찾지 못했다");
  for (const block of launches) {
    assert(/headless:\s*false/.test(block), "headless: false 가 명시되지 않은 실행이 있다");
  }
});

// --- 2. 차단 우회·결제 자동화가 없다 ----------------------------------------
check("Provider 계약이 차단 우회·결제 자동화 이름을 거부한다", () => {
  const contract = read("agent/src/providers/provider-contract.mjs");
  for (const name of [
    "solveCaptcha",
    "bypassQueue",
    "rotateUserAgent",
    "rotateProxy",
    "rotateAccount",
    "evadeDetection",
    "exportCookies",
    "autoPay",
    "submitPayment",
  ]) {
    assert(contract.includes(`"${name}"`), `금지 목록에 ${name} 가 없다`);
  }
});

check("실제 Provider에 차단 우회·결제 기능이 없다", () => {
  const body = stripComments(read("agent/src/providers/sr-srt-live-provider.mjs"));
  for (const pattern of [/captcha/i, /bypass/i, /proxy/i, /userAgent/i, /setExtraHTTPHeaders/]) {
    assert(!pattern.test(body), `우회로 보이는 코드가 있다: ${pattern}`);
  }
  // 결제 관련 동작이 아예 없어야 한다. 결제 "화면 감지"는 중단용이라 허용한다.
  assert(!/(pay|payment)\s*\(/i.test(body), "결제를 수행하는 호출이 있다");
});

check("탐지 회피용 무작위 지연이 없다", () => {
  // Math.random() 으로 조회 간격을 흔드는 코드가 없어야 한다.
  assert(!/Math\.random\(\)[\s\S]{0,80}(sleep|setTimeout|interval)/i.test(agentCode),
    "무작위 지연으로 보이는 코드가 있다");
});

// --- 3. 추측한 선택자가 없다 -------------------------------------------------
check("Provider에 하드코딩된 사이트 문구·선택자가 없다", () => {
  const provider = read("agent/src/providers/sr-srt-live-provider.mjs");
  const body = provider.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 사이트 문구를 "요소를 찾거나 화면과 비교하는 데" 쓰면 안 된다.
  // 사람이 읽는 로그·오류 메시지에 같은 낱말이 들어가는 것은 무방하므로,
  // 요소 탐색/비교 호출 안에 들어간 경우만 잡는다.
  const matcherCalls = [
    ...body.matchAll(/(getByRole|getByLabel|getByText|getByPlaceholder|locator|includes|startsWith|indexOf|test)\s*\([^)]*\)/g),
  ].map((m) => m[0]);
  const screenWords = ["매진", "예약하기", "예매하기", "일반실", "특실", "조회하기", "예약내역", "결제기한"];
  for (const word of screenWords) {
    assert(
      !matcherCalls.some((call) => call.includes(word)),
      `화면 문구 "${word}" 로 요소를 찾거나 비교한다. 프로필에서 읽어야 한다`,
    );
  }
  // 어휘는 반드시 프로필에서 와야 한다.
  assert(/profile\.vocabulary/.test(body), "프로필 어휘를 쓰지 않는다");
  // CSS 선택자도 사이트별 클래스/아이디를 쓰면 안 된다.
  assert(!/querySelector(All)?\(\s*["'`][.#]/.test(body), "사이트별 클래스/아이디 선택자가 있다");
});

check("대상 호스트가 코드가 아니라 프로필에서 온다", () => {
  const provider = read("agent/src/providers/sr-srt-live-provider.mjs");
  const body = provider.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert(!/srail|korail|letskorail/i.test(body), "대상 호스트가 코드에 박혀 있다");
  assert(/profile\.host/.test(body), "프로필의 host 를 쓰지 않는다");
});

check("확인되지 않은 프로필로는 실행되지 않는다", () => {
  const profile = read("agent/src/profile.mjs");
  assert(/PROVIDER_PROFILE_REQUIRED/.test(profile), "거부 코드가 없다");
  assert(/!profile\.verified/.test(profile), "verified 검사가 없다");
});

// --- 4. 예약 안전장치 --------------------------------------------------------
check("읽기 전용 모드에는 예약 전이가 존재하지 않는다", () => {
  const machine = read("agent/src/machine.mjs");
  const armedBlock = machine.split("ARMED_ONLY_TRANSITIONS")[1] ?? "";
  assert(/RESERVING/.test(armedBlock), "RESERVING 이 ARMED 전용 전이에 없다");
  // BASE_TRANSITIONS 안에서는 RESERVING 이 도달 대상이면 안 된다.
  const baseBlock = machine.split("const BASE_TRANSITIONS")[1].split("/** ARMED")[0];
  const seatFound = baseBlock.split("[JobState.SEAT_FOUND]:")[1].split("]")[0];
  assert(!/RESERVING/.test(seatFound), "읽기 전용 경로에서 RESERVING 으로 갈 수 있다");
});

check("예약 클릭 직전에 펜싱 토큰을 확인한다", () => {
  const provider = read("agent/src/providers/sr-srt-live-provider.mjs");
  const reserve = provider.split("async requestReservation")[1].split("async verifyReservation")[0];
  assert(/lock\.assertFencingToken\(\)/.test(reserve), "펜싱 토큰 확인이 없다");
});

check("예약 성공은 예약내역 재확인으로만 판정한다", () => {
  const runner = read("agent/src/runner.mjs");
  const reserve = runner.split("async #reserve")[1];
  assert(/verifyReservation/.test(reserve), "예약내역 재확인이 없다");
  // 클릭 결과만으로 성공 상태로 가면 안 된다.
  const successIndex = reserve.indexOf("RESERVED_PAYMENT_REQUIRED");
  const verifyIndex = reserve.lastIndexOf("verifyReservation");
  assert(successIndex > verifyIndex, "재확인 전에 성공 상태로 간다");
  assert(/verified\.confirmed/.test(reserve), "확인 결과를 보지 않는다");
});

check("예약 요청 직전에 기존 예약과 좌석 상태를 다시 확인한다", () => {
  const runner = read("agent/src/runner.mjs");
  const reserve = runner.split("async #reserve")[1].split("#stopOtherCandidates(keepId)")[0];
  const existingIdx = reserve.indexOf("existing.confirmed");
  const recheckIdx = reserve.indexOf("readSeatAvailability");
  const clickIdx = reserve.indexOf("requestReservation");
  assert(existingIdx > -1 && existingIdx < clickIdx, "기존 예약 확인이 클릭보다 뒤에 있다");
  assert(recheckIdx > -1 && recheckIdx < clickIdx, "좌석 재확인이 클릭보다 뒤에 있다");
});

check("예약이 확인되면 나머지 후보를 중단한다", () => {
  const runner = read("agent/src/runner.mjs");
  assert(/#stopOtherCandidates/.test(runner), "나머지 후보 중단 코드가 없다");
  const reserve = runner.split("async #reserve")[1];
  assert(
    (reserve.match(/#stopOtherCandidates/g) ?? []).length >= 2,
    "기존 예약 발견과 예약 성공 두 경우 모두에서 중단해야 한다",
  );
});

check("결제기한은 화면에서 읽은 값만 쓴다", () => {
  const provider = read("agent/src/providers/sr-srt-live-provider.mjs");
  const deadline = provider.split("async readPaymentDeadline")[1].split("async stop")[0];
  assert(/found:\s*false/.test(deadline), "읽지 못했을 때 found:false 를 돌려주지 않는다");
  // 10분 같은 기본 기한을 만들어내면 안 된다.
  assert(!/10\s*\*\s*60|600000|addMinutes/.test(deadline), "결제기한을 만들어내는 코드가 있다");
});

// --- 5. 반복 조회 정책 -------------------------------------------------------
check("실제 조회 주기가 시뮬레이터와 분리돼 있고 하한이 있다", () => {
  const config = read("agent/src/config.mjs");
  assert(/livePollingIntervalSeconds/.test(config), "별도 이름을 쓰지 않는다");
  assert(/MIN_LIVE_POLLING_INTERVAL_SECONDS\s*=\s*30/.test(config), "하한이 30초가 아니다");
  assert(/DEFAULT_LIVE_POLLING_INTERVAL_SECONDS\s*=\s*60/.test(config), "기본값이 60초가 아니다");
  const runner = read("agent/src/runner.mjs");
  assert(/MIN_LIVE_POLLING_INTERVAL_SECONDS/.test(runner), "루프에서 하한을 강제하지 않는다");
});

check("네트워크 백오프에 상한이 있다", () => {
  const config = read("agent/src/config.mjs");
  assert(/NETWORK_BACKOFF_SECONDS\s*=\s*Object\.freeze\(\[/.test(config), "백오프 배열이 없다");
  const runner = read("agent/src/runner.mjs");
  assert(/NETWORK_BACKOFF_EXHAUSTED/.test(runner), "상한 초과 시 중단하지 않는다");
});

check("동시 실행 작업은 하나로 제한된다", () => {
  const config = read("agent/src/config.mjs");
  assert(/MAX_CONCURRENT_LIVE_JOBS\s*=\s*1/.test(config), "동시 실행이 1이 아니다");
  const lock = read("agent/src/lock.mjs");
  assert(/ALREADY_RUNNING/.test(lock), "중복 실행 거부가 없다");
});

check("로그인 만료 시 자동 재로그인을 시도하지 않는다", () => {
  const runner = read("agent/src/runner.mjs");
  assert(/LOGIN_EXPIRED.*AUTH_REQUIRED|AUTH_REQUIRED/.test(runner), "로그인 만료 처리가 없다");
  assert(!/relogin|reLogin|autoLogin/i.test(agentCode), "자동 재로그인 코드가 있다");
});

// --- 6. 개인정보 보호 --------------------------------------------------------
check("모든 로그가 마스킹을 거친다", () => {
  const log = read("agent/src/log.mjs");
  assert(/redactValue/.test(log), "로그가 마스킹을 거치지 않는다");
  const ipc = read("agent/src/ipc-server.mjs");
  assert(/redactValue/.test(ipc), "IPC 응답이 마스킹을 거치지 않는다");
  const runner = read("agent/src/runner.mjs");
  assert(/redactValue/.test(runner), "상태 스냅샷이 마스킹을 거치지 않는다");
});

check("DOM 원문을 기록하지 않는다", () => {
  assert(!/innerHTML|outerHTML/.test(read("agent/src/runner.mjs")), "runner 가 HTML 을 다룬다");
  assert(!/log\.[a-z]+\([^)]*innerHTML/.test(agentCode), "HTML 을 로그에 남긴다");
  const provider = read("agent/src/providers/sr-srt-live-provider.mjs");
  assert(/safeScreenText/.test(provider), "화면 문구 길이 제한을 쓰지 않는다");
});

check("로컬 서버는 127.0.0.1 에만 바인딩한다", () => {
  const ipc = stripComments(read("agent/src/ipc-server.mjs"));
  assert(/listen\(port,\s*"127\.0\.0\.1"/.test(ipc), "127.0.0.1 바인딩이 아니다");
  assert(!/0\.0\.0\.0/.test(ipc), "0.0.0.0 으로 열려 있다");
  assert(/PAIRING_REQUIRED/.test(ipc), "페어링 토큰 검사가 없다");
});

// --- 7. 시뮬레이터와의 분리 --------------------------------------------------
check("실제 Provider 이름이 Mock 과 구분된다", () => {
  const contract = read("agent/src/providers/provider-contract.mjs");
  assert(/startsWith\("live:"\)/.test(contract), "live: 접두사 검사가 없다");
  assert(/simulation !== false/.test(contract), "simulation=false 검사가 없다");
  const provider = read("agent/src/providers/sr-srt-live-provider.mjs");
  assert(/name:\s*`live:SR-SRT@/.test(provider), "Provider 이름에 사업자가 없다");
  assert(/simulation:\s*false/.test(provider), "simulation:false 가 없다");
});

check("Agent 가 시뮬레이터 코드를 가져다 쓰지 않는다", () => {
  for (const pattern of [/lib\/automation-demo/, /lib\/demo/, /mock-booking-site/, /mock-provider/]) {
    assert(!pattern.test(agentCode), `시뮬레이터를 참조한다: ${pattern}`);
  }
});

check("웹 UI 가 실제 상태와 시연을 구분해 표시한다", () => {
  const panel = read("components/live-agent-panel.tsx");
  assert(/시뮬레이터 아님/.test(panel), "실제 연동임을 표시하지 않는다");
  assert(/직접 결제/.test(panel), "직접 결제 안내가 없다");
  assert(/화면에서 확인하지 못했습니다/.test(panel), "결제기한 미확인 표시가 없다");
  assert(!/자동 결제|결제 진행/.test(panel), "결제를 진행하는 문구가 있다");
});

// --- 결과 -------------------------------------------------------------------
const result = {
  result: failures.length === 0 ? "PASS" : "FAIL",
  passed: checks.length,
  failed: failures.length,
  // 이 스크립트는 네트워크에 나가지 않는다.
  networkCalls: 0,
  note: "소스 검사만 수행한다. 실제 사이트 연동 검증이 아니다.",
};
if (failures.length > 0) result.failures = failures;
console.log(JSON.stringify(result));
process.exit(failures.length === 0 ? 0 : 1);
