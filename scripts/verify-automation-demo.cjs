// Offline contract checks for the public, login-free automation macro demo
// (lib/automation-demo/**, components/automation-demo/**,
// app/demo/booking-automation). No production credentials, no external
// network calls, no dependency on lib/auth/**, lib/watch/**,
// lib/reservation/**, lib/rail/**, or lib/automation/** -- this is a fully
// separate, client-only module tree (see lib/automation-demo/types.ts's
// header comment). scripts/verify-rail.cjs, verify-reservation.cjs,
// verify-seat-watch.cjs, verify-demo-showcase.cjs, and
// verify-booking-simulator.cjs are not duplicated here and must all still
// pass on their own.
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

let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`automation-demo must never call fetch (attempted: ${url})`);
};
function ForbiddenXHR() {
  throw new Error('automation-demo must never construct XMLHttpRequest');
}
global.XMLHttpRequest = ForbiddenXHR;
function ForbiddenWebSocket() {
  throw new Error('automation-demo must never construct WebSocket');
}
global.WebSocket = ForbiddenWebSocket;

function readSource(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function withFixedDate(fixedMs, fn) {
  const OriginalDate = global.Date;
  class FixedDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedMs);
      } else {
        super(...args);
      }
    }
    static now() {
      return fixedMs;
    }
  }
  global.Date = FixedDate;
  try {
    return fn();
  } finally {
    global.Date = OriginalDate;
  }
}

function makeFakeStorage() {
  const backing = new Map();
  return {
    backing,
    storage: {
      getItem: (key) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => backing.set(key, value),
      removeItem: (key) => backing.delete(key),
    },
  };
}

function automationDemoSourceFiles() {
  const files = [];
  for (const dir of ['lib/automation-demo', 'components/automation-demo', 'app/demo/booking-automation']) {
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
  const stateMachine = load('lib/automation-demo/state-machine.ts');
  const scenarios = load('lib/automation-demo/scenarios.ts');
  const reducerModule = load('lib/automation-demo/reducer.ts');
  const timerModule = load('lib/automation-demo/timer.ts');
  const storageModule = load('lib/automation-demo/storage.ts');

  const { canTransition, assertTransition, isTerminalStatus } = stateMachine;
  const { automationDemoReducer, createDefaultAutomationDemoState, computeElapsedSeconds, MIN_SELECTED_CANDIDATES } = reducerModule;

  // -- 1. 허용된 상태 전이 전체 / 잘못된 상태 전이 거부 ----------------------
  const FORWARD_PATH = ['READY', 'WATCHING', 'SEAT_FOUND', 'PURCHASE_CLICKING', 'RESERVING', 'PAYMENT_PENDING', 'COMPLETED'];
  for (let i = 0; i < FORWARD_PATH.length - 1; i += 1) {
    assert.equal(canTransition(FORWARD_PATH[i], FORWARD_PATH[i + 1]), true, `${FORWARD_PATH[i]} -> ${FORWARD_PATH[i + 1]} must be allowed`);
  }
  for (const active of ['WATCHING', 'SEAT_FOUND', 'PURCHASE_CLICKING', 'RESERVING', 'PAYMENT_PENDING']) {
    assert.equal(canTransition(active, 'CANCELLED'), true, `${active} -> CANCELLED must be allowed`);
  }
  assert.equal(canTransition('PAYMENT_PENDING', 'PAYMENT_EXPIRED'), true, 'PAYMENT_PENDING -> PAYMENT_EXPIRED(결제기한 만료) must be allowed');
  // PAYMENT_EXPIRED는 비종료 상태이므로(다시 감시로 새 journey 시작 가능),
  // 다른 모든 비종료 상태와 마찬가지로 CANCELLED로는 이동할 수 있다.
  assert.equal(canTransition('PAYMENT_EXPIRED', 'CANCELLED'), true);
  const INVALID_PAIRS = [
    ['READY', 'SEAT_FOUND'],
    ['READY', 'PAYMENT_PENDING'],
    ['WATCHING', 'PURCHASE_CLICKING'],
    ['WATCHING', 'READY'],
    ['SEAT_FOUND', 'RESERVING'],
    ['SEAT_FOUND', 'WATCHING'],
    ['PURCHASE_CLICKING', 'PAYMENT_PENDING'],
    ['RESERVING', 'COMPLETED'],
    ['COMPLETED', 'READY'],
    ['COMPLETED', 'WATCHING'],
    ['COMPLETED', 'CANCELLED'],
    ['CANCELLED', 'READY'],
    ['CANCELLED', 'CANCELLED'],
    ['READY', 'READY'],
    ['PAYMENT_EXPIRED', 'COMPLETED'],
    ['PAYMENT_EXPIRED', 'READY'],
    ['PAYMENT_EXPIRED', 'WATCHING'],
    ['WATCHING', 'PAYMENT_EXPIRED'],
  ];
  for (const [from, to] of INVALID_PAIRS) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} must be rejected`);
    assert.throws(() => assertTransition(from, to), /상태로 전이할 수 없습니다/, `assertTransition must throw for ${from} -> ${to}`);
  }
  assert.equal(isTerminalStatus('COMPLETED'), true);
  assert.equal(isTerminalStatus('CANCELLED'), true);
  assert.equal(isTerminalStatus('WATCHING'), false);
  assert.equal(isTerminalStatus('PAYMENT_EXPIRED'), false, 'PAYMENT_EXPIRED는 종료 상태가 아니다 -- 다시 감시(RESTART_WATCH)로 새 journey를 시작할 수 있어야 한다');

  // -- 2. 후보 2개 미만이면 감시 시작 불가(§4) -------------------------------
  {
    const base = createDefaultAutomationDemoState();
    const oneSelected = automationDemoReducer(base, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
    const stillReady = automationDemoReducer(oneSelected, { type: 'START_WATCHING' });
    assert.equal(stillReady.status, 'READY', '후보 1개만 선택한 상태에서는 감시가 시작되면 안 된다');
    assert.equal(MIN_SELECTED_CANDIDATES, 2);
  }

  // -- 3. candidate-1(항상 매진) 반복 조회 -----------------------------------
  {
    let state = createDefaultAutomationDemoState();
    for (const id of ['auto-demo-candidate-1', 'auto-demo-candidate-2']) {
      state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: id });
    }
    state = automationDemoReducer(state, { type: 'START_WATCHING' });
    for (let i = 0; i < 4; i += 1) {
      state = automationDemoReducer(state, { type: 'TICK' });
      assert.notEqual(state.status, 'SEAT_FOUND', `${i + 1}번째 tick에서 매진 후보가 좌석을 보고하면 안 된다(candidate-1은 항상 매진)`);
    }
    const candidate1 = state.candidates.find((c) => c.id === 'auto-demo-candidate-1');
    assert.equal(candidate1.status, 'sold_out');
  }

  // -- 4/5. 지정된 회차에서 좌석 발생(candidate-2: 3회차, candidate-3: 5회차) -
  function runUntilSeatFound(selectedIds) {
    let state = createDefaultAutomationDemoState();
    for (const id of selectedIds) {
      state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: id });
    }
    state = automationDemoReducer(state, { type: 'START_WATCHING' });
    let ticks = 0;
    while (state.status === 'WATCHING' && ticks < 50) {
      state = automationDemoReducer(state, { type: 'TICK' });
      ticks += 1;
    }
    return { state, ticks };
  }

  {
    // candidate-2, candidate-3 라운드로빈: 2 -> 3 -> 2 -> 3 -> 2(3번째 자기
    // 확인, 5번째 전체 tick)에서 candidate-2가 먼저 좌석을 발견해야 한다.
    const { state, ticks } = runUntilSeatFound(['auto-demo-candidate-2', 'auto-demo-candidate-3']);
    assert.equal(state.status, 'SEAT_FOUND');
    assert.equal(state.foundCandidateId, 'auto-demo-candidate-2');
    assert.equal(ticks, 5, `candidate-2가 5번째 전체 tick(자신의 3번째 확인)에서 발견돼야 한다 (실제: ${ticks})`);
    const candidate2 = state.candidates.find((c) => c.id === 'auto-demo-candidate-2');
    assert.equal(candidate2.checkCount, 3);
    const candidate3 = state.candidates.find((c) => c.id === 'auto-demo-candidate-3');
    assert.equal(candidate3.status, 'stopped', 'candidate-2 발견 즉시 candidate-3은 중단 표시되어야 한다');
  }
  {
    // scenarios.resolveCheckTick 자체(순수 함수)로, 후보 하나만 라운드로빈
    // 대상일 때도 자신의 5번째 확인에서 정확히 좌석을 발견하는지 확인한다.
    // (reducer의 MIN_SELECTED_CANDIDATES 게이트는 UX 규칙일 뿐, 시나리오
    // 계산 자체와는 무관하다는 것을 이 테스트로 분리해서 검증한다.)
    let candidates = createDefaultAutomationDemoState().candidates;
    let foundCandidateId = null;
    for (let tick = 0; tick < 5 && !foundCandidateId; tick += 1) {
      const result = scenarios.resolveCheckTick(candidates, ['auto-demo-candidate-3'], tick, 1);
      candidates = result.candidates;
      foundCandidateId = result.foundCandidateId;
    }
    assert.equal(foundCandidateId, 'auto-demo-candidate-3');
    const candidate3 = candidates.find((c) => c.id === 'auto-demo-candidate-3');
    assert.equal(candidate3.checkCount, 5);
  }

  // -- 6/7/8/9. 좌석발견 -> 구매클릭 -> 예약 -> 가상 예약번호·결제기한 -------
  {
    const { state: seatFound } = runUntilSeatFound(['auto-demo-candidate-2', 'auto-demo-candidate-3']);
    const clicking = automationDemoReducer(seatFound, { type: 'ADVANCE_TO_PURCHASE_CLICKING' });
    assert.equal(clicking.status, 'PURCHASE_CLICKING');
    const reserving = automationDemoReducer(clicking, { type: 'ADVANCE_TO_RESERVING' });
    assert.equal(reserving.status, 'RESERVING');
    const pending = withFixedDate(new Date('2026-01-01T00:00:00.000Z').getTime(), () => automationDemoReducer(reserving, { type: 'COMPLETE_RESERVATION' }));
    assert.equal(pending.status, 'PAYMENT_PENDING');
    assert.match(pending.reservationNumber, /^RF-[A-Z0-9]{8}$/, '가상 예약번호 형식이 RF-XXXXXXXX여야 한다');
    assert.equal(pending.paymentDeadline, new Date('2026-01-01T00:10:00.000Z').toISOString(), '결제기한은 예약 성공 시점 + 10분이어야 한다');

    // -- 10. 결제 완료는 사용자 액션(CONFIRM_PAYMENT)으로만 -------------------
    const stillPending = automationDemoReducer(pending, { type: 'TICK' });
    assert.equal(stillPending.status, 'PAYMENT_PENDING', 'PAYMENT_PENDING은 TICK으로 저절로 넘어가면 안 된다');
    const completed = withFixedDate(new Date('2026-01-01T00:05:00.000Z').getTime(), () => automationDemoReducer(pending, { type: 'CONFIRM_PAYMENT' }));
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.endedAt);
  }

  // -- 11. 경과 시간 고정 (종료 후 nowMs가 흘러도 증가하지 않음) -------------
  {
    const startMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    let state = withFixedDate(startMs, () => {
      let s = createDefaultAutomationDemoState();
      s = automationDemoReducer(s, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
      s = automationDemoReducer(s, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
      return automationDemoReducer(s, { type: 'START_WATCHING' });
    });
    assert.equal(computeElapsedSeconds(state, startMs), 0);
    assert.equal(computeElapsedSeconds(state, startMs + 30_000), 30);
    const cancelledAt = startMs + 45_000;
    const cancelled = withFixedDate(cancelledAt, () => automationDemoReducer(state, { type: 'CANCEL' }));
    assert.equal(computeElapsedSeconds(cancelled, cancelledAt), 45);
    assert.equal(computeElapsedSeconds(cancelled, cancelledAt + 60_000), 45, '종료 후에는 nowMs가 흘러도 경과 시간이 더 이상 증가하면 안 된다');
  }

  // -- 12. "다시 감시"(RESTART_WATCH) -- 조건 유지, 진행 상태만 초기화 -------
  {
    const { state: pending } = (() => {
      const found = runUntilSeatFound(['auto-demo-candidate-2', 'auto-demo-candidate-3']).state;
      const clicking = automationDemoReducer(found, { type: 'ADVANCE_TO_PURCHASE_CLICKING' });
      const reserving = automationDemoReducer(clicking, { type: 'ADVANCE_TO_RESERVING' });
      return { state: automationDemoReducer(reserving, { type: 'COMPLETE_RESERVATION' }) };
    })();
    const completed = automationDemoReducer(pending, { type: 'CONFIRM_PAYMENT' });
    const restarted = automationDemoReducer(completed, { type: 'RESTART_WATCH' });
    assert.equal(restarted.status, 'WATCHING');
    assert.equal(restarted.reservationNumber, null);
    assert.equal(restarted.foundCandidateId, null);
    assert.deepEqual(restarted.selectedCandidateIds, completed.selectedCandidateIds, '다시 감시는 선택된 후보를 유지해야 한다');
    assert.ok(restarted.candidates.every((c) => c.checkCount === 0 && c.status === 'waiting'));
  }

  // -- 13. 취소(CANCEL) 이후 추가 전이 없음 ----------------------------------
  {
    let state = createDefaultAutomationDemoState();
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    state = automationDemoReducer(state, { type: 'START_WATCHING' });
    state = automationDemoReducer(state, { type: 'CANCEL' });
    assert.equal(state.status, 'CANCELLED');
    const afterTick = automationDemoReducer(state, { type: 'TICK' });
    assert.equal(afterTick.status, 'CANCELLED', 'CANCELLED 이후 TICK은 아무 효과가 없어야 한다');
    const afterCancelAgain = automationDemoReducer(state, { type: 'CANCEL' });
    assert.equal(afterCancelAgain, state, 'CANCELLED 이후 다시 CANCEL을 보내도 상태가 바뀌면 안 된다');
  }

  // -- 13b. 인원(passengers)이 좌석 수(항상 1석)보다 많으면 절대 예약 성공으로
  //         이어지지 않는다(§3 결함 수정) ------------------------------------
  {
    let state = createDefaultAutomationDemoState();
    state = automationDemoReducer(state, { type: 'SET_PASSENGERS', passengers: 2 });
    assert.equal(state.condition.passengers, 2);
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    state = automationDemoReducer(state, { type: 'START_WATCHING' });
    let ticks = 0;
    while (state.status === 'WATCHING' && ticks < 50) {
      state = automationDemoReducer(state, { type: 'TICK' });
      ticks += 1;
    }
    assert.equal(state.status, 'WATCHING', '요청 인원 2명은 이 fixture(좌석 항상 1석)로는 절대 SEAT_FOUND로 이어지면 안 된다');
    const candidate2 = state.candidates.find((c) => c.id === 'auto-demo-candidate-2');
    assert.equal(candidate2.status, 'insufficient', '좌석은 있으나 인원 미달이면 insufficient로만 표시해야 한다');
  }
  // READY 상태가 아니면 SET_PASSENGERS는 무시되고, 범위를 벗어난 값도 거부된다.
  {
    const base = createDefaultAutomationDemoState();
    const invalid = automationDemoReducer(base, { type: 'SET_PASSENGERS', passengers: 0 });
    assert.equal(invalid.condition.passengers, base.condition.passengers, '0명은 거부되어야 한다');
    const tooMany = automationDemoReducer(base, { type: 'SET_PASSENGERS', passengers: 5 });
    assert.equal(tooMany.condition.passengers, base.condition.passengers, '4명 초과는 거부되어야 한다');
  }

  // -- 13c. 좌석등급 선호(standard_only)가 후보 선정에 반영된다(§3 결함 수정) --
  {
    assert.equal(scenarios.isCandidateCompatibleWithSeatClass({ scenario: { kind: 'seat_after_n_checks', seatClass: 'special' } }, 'standard_only'), false);
    assert.equal(scenarios.isCandidateCompatibleWithSeatClass({ scenario: { kind: 'seat_after_n_checks', seatClass: 'standard' } }, 'standard_only'), true);
    assert.equal(scenarios.isCandidateCompatibleWithSeatClass({ scenario: { kind: 'always_sold_out' } }, 'standard_only'), true);

    let state = createDefaultAutomationDemoState();
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    assert.deepEqual(state.selectedCandidateIds.sort(), ['auto-demo-candidate-2', 'auto-demo-candidate-3']);
    state = automationDemoReducer(state, { type: 'SET_SEAT_CLASS_PREFERENCE', preference: 'standard_only' });
    assert.deepEqual(state.selectedCandidateIds, ['auto-demo-candidate-2'], 'standard_only로 바꾸면 특실만 있는 candidate-3(선택돼 있던)이 자동으로 선택 해제되어야 한다');

    const reselect = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    assert.deepEqual(reselect.selectedCandidateIds, ['auto-demo-candidate-2'], 'standard_only 상태에서는 특실 후보를 다시 선택할 수 없어야 한다');
  }

  // -- 13d. 희망 시간대가 후보 선정에 반영된다(§3 결함 수정) -------------------
  {
    assert.equal(scenarios.isCandidateWithinTimeRange({ departAt: '07:11' }, { timeRangeStart: '05:00', timeRangeEnd: '10:00' }), true);
    assert.equal(scenarios.isCandidateWithinTimeRange({ departAt: '11:00' }, { timeRangeStart: '05:00', timeRangeEnd: '10:00' }), false);
    assert.equal(scenarios.isCandidateWithinTimeRange({ departAt: '00:30' }, { timeRangeStart: '23:00', timeRangeEnd: '02:00' }), true, '자정을 넘는 범위도 다뤄야 한다');

    let state = createDefaultAutomationDemoState();
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    // candidate-3(08:05 출발)을 범위 밖으로 밀어낸다.
    state = automationDemoReducer(state, { type: 'SET_TIME_RANGE_END', time: '07:30' });
    assert.deepEqual(state.selectedCandidateIds, ['auto-demo-candidate-2'], '희망 종료 시각을 좁히면 범위를 벗어난 선택된 후보가 자동으로 해제되어야 한다');
    const reselect = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    assert.deepEqual(reselect.selectedCandidateIds, ['auto-demo-candidate-2'], '희망 시간대 밖의 후보는 다시 선택할 수 없어야 한다');
  }

  // -- 13e. 결제기한 만료(PAYMENT_EXPIRED) -- 감시기한과 결제기한은 별개이며,
  //         기한이 지난 가상 예약은 결제 완료로 바꿀 수 없다(§4 결함 수정) ----
  {
    const startMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const { state: pending } = withFixedDate(startMs, () => {
      const found = runUntilSeatFound(['auto-demo-candidate-2', 'auto-demo-candidate-3']).state;
      const clicking = automationDemoReducer(found, { type: 'ADVANCE_TO_PURCHASE_CLICKING' });
      const reserving = automationDemoReducer(clicking, { type: 'ADVANCE_TO_RESERVING' });
      return { state: automationDemoReducer(reserving, { type: 'COMPLETE_RESERVATION' }) };
    });
    assert.equal(pending.status, 'PAYMENT_PENDING');
    const deadlineMs = new Date(pending.paymentDeadline).getTime();

    // 기한 전에는 EXPIRE_PAYMENT가 아무 효과가 없어야 한다.
    const tooEarly = withFixedDate(deadlineMs - 1000, () => automationDemoReducer(pending, { type: 'EXPIRE_PAYMENT' }));
    assert.equal(tooEarly.status, 'PAYMENT_PENDING', '결제기한 전에는 EXPIRE_PAYMENT가 무시되어야 한다');

    // 기한이 지나면 자동으로 PAYMENT_EXPIRED로 전이된다.
    const expired = withFixedDate(deadlineMs + 1000, () => automationDemoReducer(pending, { type: 'EXPIRE_PAYMENT' }));
    assert.equal(expired.status, 'PAYMENT_EXPIRED');
    assert.ok(expired.endedAt);

    // 이미 만료된 뒤에는 CONFIRM_PAYMENT(결제 완료 클릭)를 보내도 완료로 바뀌면 안 된다.
    const stillExpired = automationDemoReducer(expired, { type: 'CONFIRM_PAYMENT' });
    assert.equal(stillExpired, expired, 'PAYMENT_EXPIRED 상태에서 CONFIRM_PAYMENT는 아무 효과가 없어야 한다');

    // 방어적 이중 검증: PAYMENT_PENDING 상태 그대로 시스템 시계만 기한을 넘긴 뒤
    // CONFIRM_PAYMENT를 직접 보내도(타이머가 아직 EXPIRE_PAYMENT를 보내기 전) 거부되어야 한다.
    const lateConfirm = withFixedDate(deadlineMs + 1000, () => automationDemoReducer(pending, { type: 'CONFIRM_PAYMENT' }));
    assert.equal(lateConfirm.status, 'PAYMENT_PENDING', '결제기한이 지난 뒤의 CONFIRM_PAYMENT는 COMPLETED로 이어지면 안 된다');

    // PAYMENT_EXPIRED에서도 "다시 감시"로 새 journey를 시작할 수 있다.
    const restarted = automationDemoReducer(expired, { type: 'RESTART_WATCH' });
    assert.equal(restarted.status, 'WATCHING');
    assert.equal(restarted.reservationNumber, null);
  }

  // -- 14. 단일 슬롯 타이머 -- 재예약 시 이전 타이머가 항상 먼저 정리됨 -------
  {
    const controller = timerModule.createAutomationDemoTimerController();
    let calls = 0;
    controller.schedule(() => {
      calls += 1;
    }, 5);
    controller.schedule(() => {
      calls += 1;
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1, '두 번째 schedule 호출이 첫 번째 타이머를 취소해야 한다(중복 실행 없음)');
    assert.equal(controller.isScheduled(), false);
  }

  // -- 15. sessionStorage 스키마 검증 ----------------------------------------
  {
    const { storage } = makeFakeStorage();
    assert.equal(storageModule.readAutomationDemoState(storage), null, '아무것도 저장되지 않았으면 null');

    let state = createDefaultAutomationDemoState();
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-2' });
    state = automationDemoReducer(state, { type: 'TOGGLE_CANDIDATE', candidateId: 'auto-demo-candidate-3' });
    state = automationDemoReducer(state, { type: 'START_WATCHING' });
    storageModule.writeAutomationDemoState(storage, state);
    const roundTripped = storageModule.readAutomationDemoState(storage);
    assert.deepEqual(roundTripped, state, '정상 상태는 저장 후 그대로 복원되어야 한다');

    storage.setItem('railflow-automation-demo-v1', '{not valid json');
    assert.equal(storageModule.readAutomationDemoState(storage), null, '손상된 JSON은 null을 반환하고 항목을 지워야 한다');
    assert.equal(storage.getItem('railflow-automation-demo-v1'), null);

    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, status: 'PAYMENT_PENDING', reservationNumber: null }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, 'PAYMENT_PENDING인데 reservationNumber가 없으면 거부해야 한다');

    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, foundCandidateId: 'not-a-real-candidate-id', status: 'SEAT_FOUND', reservationNumber: null, paymentDeadline: null }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, '존재하지 않는 foundCandidateId는 거부해야 한다');

    // 15b. 새 스키마 필드(passengers/seatClassPreference/seatCount/PAYMENT_EXPIRED)가
    // 손상되거나 범위를 벗어난 값도 안전하게 거부되어야 한다.
    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, condition: { ...state.condition, passengers: 0 } }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, 'passengers=0은 거부해야 한다');

    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, condition: { ...state.condition, passengers: 5 } }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, 'passengers=5(최대 4명 초과)는 거부해야 한다');

    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, condition: { ...state.condition, seatClassPreference: 'vip_only' } }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, '정의되지 않은 seatClassPreference는 거부해야 한다');

    const conditionWithoutPassengers = { ...state.condition };
    delete conditionWithoutPassengers.passengers;
    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, condition: conditionWithoutPassengers }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, 'passengers 필드가 아예 없는 구버전 상태는 거부해야 한다(임의 기본값으로 보완하지 않는다)');

    const badCandidates = state.candidates.map((c) => (c.scenario.kind === 'seat_after_n_checks' ? { ...c, scenario: { ...c.scenario, seatCount: -1 } } : c));
    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...state, candidates: badCandidates }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, '음수 seatCount는 거부해야 한다');

    const { state: expiredFixture } = (() => {
      const found = runUntilSeatFound(['auto-demo-candidate-2', 'auto-demo-candidate-3']).state;
      const clicking = automationDemoReducer(found, { type: 'ADVANCE_TO_PURCHASE_CLICKING' });
      const reserving = automationDemoReducer(clicking, { type: 'ADVANCE_TO_RESERVING' });
      const pending = automationDemoReducer(reserving, { type: 'COMPLETE_RESERVATION' });
      return { state: withFixedDate(new Date(pending.paymentDeadline).getTime() + 1000, () => automationDemoReducer(pending, { type: 'EXPIRE_PAYMENT' })) };
    })();
    assert.equal(expiredFixture.status, 'PAYMENT_EXPIRED');
    storageModule.writeAutomationDemoState(storage, expiredFixture);
    const roundTrippedExpired = storageModule.readAutomationDemoState(storage);
    assert.deepEqual(roundTrippedExpired, expiredFixture, 'PAYMENT_EXPIRED 상태도 정상 저장·복원되어야 한다(endedAt 포함)');

    storage.setItem('railflow-automation-demo-v1', JSON.stringify({ ...expiredFixture, endedAt: null }));
    assert.equal(storageModule.readAutomationDemoState(storage), null, 'PAYMENT_EXPIRED인데 endedAt이 없으면 거부해야 한다');
  }

  // -- 16. fetch/XHR/WebSocket 호출 0회 --------------------------------------
  assert.equal(fetchCalls, 0, 'lib/automation-demo 모듈 로드·실행 중 fetch가 호출되면 안 된다');

  // -- 17. 정적 소스 검사: 인증·자동화·철도 API 호출, 금지 문구, 개인정보 필드,
  //        경계(lib/auth|watch|reservation|rail|automation import 금지) ------
  const files = automationDemoSourceFiles();
  assert.ok(files.length >= 6, 'lib/automation-demo, components/automation-demo, app/demo/booking-automation 아래 소스 파일을 찾지 못했다');
  const FORBIDDEN_API_SUBSTRINGS = ['/api/auth', '/api/automation-jobs', '/api/automation/mock-site', '/api/watch-jobs', '/api/reservations', 'data.go.kr', 'kric.go.kr', 'srail.or.kr', 'korail.com', 'letskorail.com'];
  const FORBIDDEN_PII_PATTERNS = [/\bpassword\s*[:=]/i, /\bemail\s*[:=]/i, /type=["']password["']/i, /type=["']email["']/i];
  const FORBIDDEN_CALL_TOKENS = ['fetch(', 'XMLHttpRequest', 'new WebSocket', 'navigator.sendBeacon'];
  const OPERATIONAL_IMPORT_PATTERN = /@\/lib\/(auth|watch|reservation|rail|automation)\//;

  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  for (const file of files) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    const code = stripComments(source);
    assert.equal(code.includes('server-only'), false, `${relative}: 이 시연은 "server-only"를 import하면 안 된다(로그인 없이도 접근 가능해야 함)`);
    assert.equal(OPERATIONAL_IMPORT_PATTERN.test(code), false, `${relative}: lib/auth|watch|reservation|rail|automation을 import하면 안 된다 -- 완전히 분리된 모듈이어야 한다`);
    for (const forbidden of FORBIDDEN_API_SUBSTRINGS) {
      assert.equal(code.includes(forbidden), false, `${relative}: 운영/실제 API 또는 외부 도메인("${forbidden}")을 참조하면 안 된다`);
    }
    for (const pattern of FORBIDDEN_PII_PATTERNS) {
      assert.equal(pattern.test(code), false, `${relative}: 개인정보 필드/입력(${pattern})을 포함하면 안 된다`);
    }
    for (const forbidden of FORBIDDEN_CALL_TOKENS) {
      assert.equal(code.includes(forbidden), false, `${relative}: "${forbidden}" 호출을 포함하면 안 된다(네트워크 호출 금지)`);
    }
    assert.equal(code.includes('NODE_ENV'), false, `${relative}: 이 시연은 Production을 포함한 모든 배포에서 항상 접근 가능해야 하므로 NODE_ENV로 화면을 숨기면 안 된다`);
  }

  // scenarios.ts 자체도 실제 자동화 시나리오 숫자를 그대로 옮겼는지 확인
  // (문서·시연상 일관성 -- 코드 의존성은 없음, 정적 소스에 숫자가 존재하는지만 확인).
  const scenarioSource = readSource('lib/automation-demo/scenarios.ts');
  assert.ok(scenarioSource.includes('checksRequired: 3'), '시연 candidate-2는 3회차 시나리오를 써야 한다');
  assert.ok(scenarioSource.includes('checksRequired: 5'), '시연 candidate-3은 5회차 시나리오를 써야 한다');
  void scenarios;

  console.log(JSON.stringify({ result: 'PASS', fetchCalls, checkedFiles: files.length }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
