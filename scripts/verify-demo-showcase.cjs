// Offline contract checks for the v0.6 "Demo Showcase" (lib/demo/**,
// components/demo/**, app/demo/**). No production credentials, no external
// network calls, no dependency on lib/auth/**, lib/watch/**,
// lib/reservation/**, or lib/rail/** -- the Demo Showcase is a fully
// separate, client-only module tree (see lib/demo/types.ts's header
// comment). scripts/verify-rail.cjs, verify-reservation.cjs, and
// verify-seat-watch.cjs are not duplicated here and must all still pass on
// their own.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader isolates TypeScript modules for offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const loadedModules = new Map();

function load(relative) {
  const filename = path.join(root, relative);
  if (loadedModules.has(filename)) return loadedModules.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  loadedModules.set(filename, mod);
  mod.require = (name) =>
    name === 'server-only'
      ? {}
      : name.startsWith('@/')
        ? load(name.slice(2) + '.ts')
        : require(name);
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    filename,
  );
  return mod.exports;
}

// The Demo Showcase must never open a network connection of any kind.
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`Demo Showcase must never call fetch (attempted: ${url})`);
};
function ForbiddenXHR() {
  throw new Error('Demo Showcase must never construct XMLHttpRequest');
}
global.XMLHttpRequest = ForbiddenXHR;
function ForbiddenWebSocket() {
  throw new Error('Demo Showcase must never construct WebSocket');
}
global.WebSocket = ForbiddenWebSocket;

function readSource(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function demoSourceFiles() {
  const files = [];
  for (const dir of ['lib/demo', 'components/demo', 'app/demo']) {
    const abs = path.join(root, dir);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        files.push(path.join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  }
  return files;
}

async function main() {
  const stateMachine = load('lib/demo/state-machine.ts');
  const scenarios = load('lib/demo/scenarios.ts');
  const reducerModule = load('lib/demo/reducer.ts');
  const timerModule = load('lib/demo/timer.ts');
  const storageModule = load('lib/demo/storage.ts');
  const typesModule = load('lib/demo/types.ts');

  const { canTransition, assertTransition, isTerminalStatus } = stateMachine;
  const { demoReducer, createDefaultDemoState } = reducerModule;

  // -- 1. 허용된 상태 전이 전체 -------------------------------------------
  const FORWARD_PATH = ['READY', 'REGISTERED', 'WATCHING', 'SEAT_FOUND', 'NOTIFIED', 'FINISHED'];
  for (let i = 0; i < FORWARD_PATH.length - 1; i += 1) {
    assert.equal(canTransition(FORWARD_PATH[i], FORWARD_PATH[i + 1]), true, `${FORWARD_PATH[i]} -> ${FORWARD_PATH[i + 1]} must be allowed`);
  }
  for (const active of ['REGISTERED', 'WATCHING', 'SEAT_FOUND', 'NOTIFIED']) {
    assert.equal(canTransition(active, 'CANCELLED'), true, `${active} -> CANCELLED must be allowed (user cancel)`);
  }

  // -- 2. 잘못된 상태 전이 거부 --------------------------------------------
  const INVALID_PAIRS = [
    ['READY', 'WATCHING'], // 단계 건너뛰기
    ['READY', 'SEAT_FOUND'],
    ['WATCHING', 'READY'],
    ['WATCHING', 'NOTIFIED'], // SEAT_FOUND 건너뛰기
    ['SEAT_FOUND', 'WATCHING'], // 역방향 (resume 없음)
    ['NOTIFIED', 'SEAT_FOUND'],
    ['NOTIFIED', 'WATCHING'],
    ['FINISHED', 'READY'],
    ['FINISHED', 'WATCHING'],
    ['FINISHED', 'CANCELLED'], // 종료 상태에서는 취소도 불가
    ['CANCELLED', 'READY'],
    ['CANCELLED', 'WATCHING'],
    ['CANCELLED', 'CANCELLED'],
    ['READY', 'READY'],
  ];
  for (const [from, to] of INVALID_PAIRS) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} must be rejected`);
    assert.throws(() => assertTransition(from, to), /상태로 전이할 수 없습니다/, `assertTransition must throw for ${from} -> ${to}`);
  }
  assert.equal(isTerminalStatus('FINISHED'), true);
  assert.equal(isTerminalStatus('CANCELLED'), true);
  assert.equal(isTerminalStatus('WATCHING'), false);

  // -- 3/4. 1~5초 정수만 허용, 그 외 전부 거부 ------------------------------
  function stateWithInterval(seconds) {
    const base = createDefaultDemoState();
    return demoReducer(base, { type: 'SET_INTERVAL', seconds });
  }
  for (const valid of [1, 2, 3, 4, 5]) {
    assert.equal(stateWithInterval(valid).intervalSeconds, valid, `${valid}초는 허용돼야 한다`);
  }
  const REJECTED_INTERVALS = [0, 6, 1.5, 2.9, '2', null, undefined, [2], { seconds: 2 }, NaN, -1];
  for (const invalid of REJECTED_INTERVALS) {
    const base = createDefaultDemoState();
    const next = demoReducer(base, { type: 'SET_INTERVAL', seconds: invalid });
    assert.equal(next.intervalSeconds, base.intervalSeconds, `잘못된 간격 값(${JSON.stringify(invalid)})은 거부되고 기존 값을 유지해야 한다`);
  }

  // -- 5. 좌석 발견 후 다른 후보 감시 자동 중단 ------------------------------
  function dispatchAll(state, actions) {
    return actions.reduce((current, action) => demoReducer(current, action), state);
  }
  {
    let state = createDefaultDemoState();
    const [first, second, third] = state.candidates;
    state = dispatchAll(state, [
      { type: 'TOGGLE_CANDIDATE', candidateId: first.id },
      { type: 'TOGGLE_CANDIDATE', candidateId: second.id },
      { type: 'REGISTER' },
      { type: 'START_WATCHING' },
      { type: 'TICK' }, // tick 1: 아직 발견 전 (SEAT_FOUND_AT_TICK=2)
    ]);
    assert.equal(state.status, 'WATCHING', 'tick 1에서는 아직 좌석이 발견되면 안 된다');
    assert.equal(state.candidates.find((c) => c.id === first.id).status, 'watching');
    assert.equal(state.candidates.find((c) => c.id === second.id).status, 'watching');
    assert.equal(state.candidates.find((c) => c.id === third.id).status, 'watching', '선택하지 않은 후보는 건드리지 않는다');

    state = demoReducer(state, { type: 'TICK' }); // tick 2: 발견
    assert.equal(state.status, 'SEAT_FOUND', '두 번째 감시 단계에서 좌석이 발견돼야 한다(결정론적)');
    assert.equal(state.foundCandidateId, first.id, '선택된 후보 중 첫 번째가 발견돼야 한다');
    assert.equal(state.candidates.find((c) => c.id === first.id).status, 'seat_found');
    assert.equal(state.candidates.find((c) => c.id === second.id).status, 'stopped', '나머지 선택된 후보는 감시 중단으로 표시돼야 한다');
    assert.equal(state.candidates.find((c) => c.id === third.id).status, 'watching', '선택하지 않은 후보는 영향받지 않는다');

    state = demoReducer(state, { type: 'MARK_NOTIFIED' });
    assert.equal(state.status, 'NOTIFIED');
    assert.equal(state.notifications.length, 1);
    const dump = JSON.stringify(state);
    for (const forbidden of ['RESERVED', 'HELD', 'PAYMENT_COMPLETED']) {
      assert.equal(dump.includes(forbidden), false, `상태 직렬화 결과에 "${forbidden}" 문구가 없어야 한다`);
    }

    state = demoReducer(state, { type: 'FINISH' });
    assert.equal(state.status, 'FINISHED');
  }

  // -- 6. 취소 후 추가 상태 전이 없음 --------------------------------------
  {
    let state = createDefaultDemoState();
    const [first] = state.candidates;
    state = dispatchAll(state, [
      { type: 'TOGGLE_CANDIDATE', candidateId: first.id },
      { type: 'REGISTER' },
      { type: 'START_WATCHING' },
      { type: 'CANCEL' },
    ]);
    assert.equal(state.status, 'CANCELLED');
    const afterCancel = dispatchAll(state, [
      { type: 'TICK' },
      { type: 'START_WATCHING' },
      { type: 'MARK_NOTIFIED' },
      { type: 'FINISH' },
      { type: 'REGISTER' },
      { type: 'CANCEL' },
      { type: 'TOGGLE_CANDIDATE', candidateId: first.id },
      { type: 'SET_DATE', date: '2099-01-01' },
    ]);
    assert.deepEqual(afterCancel, state, 'CANCELLED 이후에는 어떤 액션도 상태를 바꾸면 안 된다');
  }

  // -- 7. 재시작(RESTART_JOURNEY) 시 진행 상태 초기화, 조건/선택/간격 유지 --
  {
    let state = createDefaultDemoState();
    const [first, second] = state.candidates;
    state = dispatchAll(state, [
      { type: 'TOGGLE_CANDIDATE', candidateId: first.id },
      { type: 'TOGGLE_CANDIDATE', candidateId: second.id },
      { type: 'SET_INTERVAL', seconds: 4 },
      { type: 'REGISTER' },
      { type: 'START_WATCHING' },
      { type: 'TICK' },
      { type: 'TICK' },
    ]);
    assert.equal(state.status, 'SEAT_FOUND');
    const restarted = demoReducer(state, { type: 'RESTART_JOURNEY' });
    assert.equal(restarted.status, 'READY');
    assert.equal(restarted.watchTick, 0);
    assert.equal(restarted.foundCandidateId, null);
    assert.deepEqual(restarted.history, []);
    assert.deepEqual(restarted.notifications, []);
    assert.equal(restarted.intervalSeconds, 4, '재시작 후에도 시연 간격은 유지돼야 한다');
    assert.deepEqual(restarted.selectedCandidateIds, [first.id, second.id], '재시작 후에도 선택한 후보는 유지돼야 한다');
    assert.ok(restarted.candidates.every((c) => c.status === 'watching'), '재시작 후 모든 후보는 watching 상태로 되돌아가야 한다');
  }

  // -- 8. 재시작/취소/unmount 시 timer 중복 없음 ---------------------------
  {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const pending = new Map();
    let nextId = 1;
    let setCalls = 0;
    let clearCalls = 0;
    global.setTimeout = (callback) => {
      setCalls += 1;
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    };
    global.clearTimeout = (id) => {
      clearCalls += 1;
      pending.delete(id);
    };
    try {
      const controller = timerModule.createDemoTimerController();
      const fired = [];
      controller.schedule(() => fired.push('a'), 1000);
      assert.equal(setCalls, 1);
      assert.equal(controller.isScheduled(), true);

      // 재시작을 흉내낸 재호출: 이전 타이머는 발화 전에 반드시 정리돼야 한다.
      controller.schedule(() => fired.push('b'), 1000);
      assert.equal(clearCalls, 1, '재시작(재schedule) 시 이전 타이머를 먼저 clear해야 한다');
      assert.equal(pending.size, 1, '대기 중인 타이머는 항상 최대 1개여야 한다');

      const [[firedId, onlyPendingCallback]] = pending;
      pending.delete(firedId); // a real timer removes itself once it fires
      onlyPendingCallback();
      assert.deepEqual(fired, ['b'], '재시작 전의 콜백("a")은 절대 발화하면 안 된다 -- 상태가 두 단계 건너뛰는 것을 방지');
      assert.equal(controller.isScheduled(), false);

      // 취소/unmount를 흉내낸 명시적 clear.
      controller.schedule(() => fired.push('c'), 500);
      controller.clear();
      assert.equal(pending.size, 0, 'clear() 이후에는 대기 중인 타이머가 없어야 한다');
      assert.deepEqual(fired, ['b'], 'clear() 이후에는 어떤 콜백도 추가로 발화하면 안 된다');
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  }

  // -- 9. 초기화 시 sessionStorage 데이터 제거 ------------------------------
  {
    const backing = new Map();
    const fakeStorage = {
      getItem: (key) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => backing.set(key, value),
      removeItem: (key) => backing.delete(key),
    };
    const state = createDefaultDemoState();
    storageModule.writeDemoState(fakeStorage, state);
    assert.ok(backing.has(typesModule.DEMO_STORAGE_KEY), '정상 상태는 저장돼야 한다');
    const roundTrip = storageModule.readDemoState(fakeStorage);
    assert.deepEqual(roundTrip, state);

    storageModule.clearDemoState(fakeStorage);
    assert.equal(backing.has(typesModule.DEMO_STORAGE_KEY), false, '데모 초기화는 sessionStorage 항목을 완전히 제거해야 한다');
    assert.equal(storageModule.readDemoState(fakeStorage), null);

    // 손상된/알 수 없는 형태의 데이터는 조용히 무시하고 null을 반환해야 한다
    // (크래시하거나 잘못된 상태로 렌더링하면 안 된다).
    backing.set(typesModule.DEMO_STORAGE_KEY, JSON.stringify({ not: 'a demo state' }));
    assert.equal(storageModule.readDemoState(fakeStorage), null);
    backing.set(typesModule.DEMO_STORAGE_KEY, 'not even json{{{');
    assert.equal(storageModule.readDemoState(fakeStorage), null);

    // sessionStorage 자체가 예외를 던져도(프라이빗 모드 등) 크래시하면 안 된다.
    const throwingStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    assert.doesNotThrow(() => storageModule.writeDemoState(throwingStorage, state));
    assert.doesNotThrow(() => storageModule.clearDemoState(throwingStorage));
    assert.equal(storageModule.readDemoState(throwingStorage), null);
  }

  // -- 10. scenarios/reducer 순수 로직 실행 중 fetch 호출 0회 ----------------
  assert.equal(fetchCalls, 0, 'lib/demo 모듈 로드·실행 중 fetch가 호출되면 안 된다');

  // -- 11. 정적 소스 검사: 인증·철도·알림 API 호출, 금지 문구, 개인정보 필드 --
  const files = demoSourceFiles();
  assert.ok(files.length >= 6, 'lib/demo, components/demo, app/demo 아래 소스 파일을 찾지 못했다');
  const FORBIDDEN_API_SUBSTRINGS = ['/api/auth', '/api/watch-jobs', '/api/reservations', 'data.go.kr', 'kric.go.kr', 'srail.or.kr'];
  const FORBIDDEN_STATUS_WORDS = ['RESERVED', 'HELD', 'PAYMENT_COMPLETED'];
  // 필드/입력 선언만 검사한다(주석에서 "이메일·비밀번호를 저장하지 않는다"를
  // 설명하는 것은 허용) -- 아래에서 주석을 먼저 제거한 코드에 대해 검사한다.
  const FORBIDDEN_PII_PATTERNS = [/\bpassword\s*[:=]/i, /\bemail\s*[:=]/i, /type=["']password["']/i, /type=["']email["']/i];
  const FORBIDDEN_CALL_TOKENS = ['fetch(', 'XMLHttpRequest', 'new WebSocket', 'navigator.sendBeacon'];
  const OPERATIONAL_IMPORT_PATTERN = /@\/lib\/(auth|watch|reservation|rail)\//;

  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  for (const file of files) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    const code = stripComments(source);
    assert.equal(code.includes('server-only'), false, `${relative}: Demo Showcase는 "server-only"를 import하면 안 된다(운영 빌드에서도 접근 가능해야 함, §4.2/§14)`);
    assert.equal(OPERATIONAL_IMPORT_PATTERN.test(code), false, `${relative}: lib/auth|watch|reservation|rail을 import하면 안 된다 -- Demo Showcase는 완전히 분리된 모듈이어야 한다`);
    for (const forbidden of FORBIDDEN_API_SUBSTRINGS) {
      assert.equal(code.includes(forbidden), false, `${relative}: 운영/실제 API 주소("${forbidden}")를 참조하면 안 된다`);
    }
    for (const forbidden of FORBIDDEN_STATUS_WORDS) {
      assert.equal(code.includes(forbidden), false, `${relative}: "${forbidden}" 같은 실제 예약/결제 완료를 뜻하는 표현을 쓰면 안 된다`);
    }
    for (const pattern of FORBIDDEN_PII_PATTERNS) {
      assert.equal(pattern.test(code), false, `${relative}: 개인정보 필드/입력(${pattern})을 포함하면 안 된다`);
    }
    for (const forbidden of FORBIDDEN_CALL_TOKENS) {
      assert.equal(code.includes(forbidden), false, `${relative}: "${forbidden}" 호출을 포함하면 안 된다(네트워크 호출 금지)`);
    }
    assert.equal(code.includes('NODE_ENV'), false, `${relative}: /demo는 Production 빌드에서도 항상 접근 가능해야 하므로 NODE_ENV로 화면을 숨기면 안 된다`);
  }

  // 공식 예매 주소는 재사용하되(§8), 새로운 비공개 딥링크를 추측하지 않는다.
  assert.equal(scenarios.OFFICIAL_BOOKING_URL, 'https://www.korail.com/');
  const scenarioSource = readSource('lib/demo/scenarios.ts');
  assert.equal(/[?&]departure=|[?&]arrival=|[?&]date=/.test(scenarioSource), false, '검색 조건을 URL query로 공식 사이트에 전달하면 안 된다');

  // -- 12. 기존 Service Worker가 /api/**를 캐시하지 않음 ---------------------
  const swSource = readSource('public/sw.js');
  assert.ok(/\/api\//.test(swSource) && /return/.test(swSource), 'public/sw.js는 여전히 /api/**를 캐시 로직에서 제외해야 한다');

  console.log(JSON.stringify({ result: 'PASS', fetchCalls, checkedFiles: files.length }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
