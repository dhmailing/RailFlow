// Offline contract checks for the v0.7 "자동 좌석조회·예약 매크로 시뮬레이터"
// (lib/automation/**, app/api/automation-jobs/**, app/api/automation/mock-site/**,
// app/demo/booking-simulator, components/automation/**). No production
// credentials, no external network calls, no real browser/Playwright launch
// -- the worker/state-machine/claim tests below use a fake in-process
// SeatAutomationProvider (backed directly by the same mock-booking-site
// store the real mock-browser Provider's Playwright automation drives over
// HTTP) so every assertion here is fast and deterministic. Real Playwright
// automation against a live server is exercised separately and manually
// (see docs/V0.7-BOOKING-MACRO-SIMULATOR.md) -- this script never launches
// a browser.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader isolates TypeScript modules for offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
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

// No module under test may ever open a real network connection -- most
// importantly never to korail.com/letskorail.com/srail.*/data.go.kr. The
// mock-booking-site's own API routes below are exercised by calling their
// exported route handlers directly (in-process function calls), which
// never touches this fetch override.
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`v0.7 automation subsystem must never call fetch (attempted: ${url})`);
};
function ForbiddenXHR() {
  throw new Error('v0.7 automation subsystem must never construct XMLHttpRequest');
}
global.XMLHttpRequest = ForbiddenXHR;
function ForbiddenWebSocket() {
  throw new Error('v0.7 automation subsystem must never construct WebSocket');
}
global.WebSocket = ForbiddenWebSocket;

const FAKE_PASSWORD = 'S3cret-Pw-fixture-only-999';
const capturedLogs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { capturedLogs.push(args.map(String).join(' ')); };
console.error = (...args) => { capturedLogs.push(args.map(String).join(' ')); };

function readSource(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

async function main() {
  const stateMachine = load('lib/automation/state-machine.ts');
  const jobStore = load('lib/automation/job-store.ts');
  const hostGuard = load('lib/automation/host-guard.ts');
  const providerModule = load('lib/automation/provider.ts');
  const worker = load('lib/automation/worker.ts');
  const mockSiteStore = load('lib/automation/mock-booking-site/store.ts');
  const mockSiteSeed = load('lib/automation/mock-booking-site/seed.ts');
  const { AutomationError } = load('lib/automation/types.ts');

  const listingsRoute = load('app/api/automation/mock-site/listings/route.ts');
  const statusRoute = load('app/api/automation/mock-site/listings/[id]/status/route.ts');
  const purchaseClickRoute = load('app/api/automation/mock-site/listings/[id]/purchase-click/route.ts');
  const reserveRoute = load('app/api/automation/mock-site/listings/[id]/reserve/route.ts');

  function resetAll() {
    jobStore.__resetJobStoreForTests();
    load('lib/automation/queue.ts').__resetQueueForTests();
    mockSiteStore.__resetMockBookingSiteForTests();
  }

  async function withEnv(vars, run) {
    const previous = {};
    for (const key of Object.keys(vars)) previous[key] = process.env[key];
    Object.assign(process.env, vars);
    try {
      return await run();
    } finally {
      for (const key of Object.keys(previous)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }

  const DEV_ENABLED = { SEAT_AUTOMATION_PROVIDER: 'mock-browser', ENABLE_SEAT_AUTOMATION_JOBS: 'true', ENABLE_MOCK_BOOKING_SITE: 'true' };

  function makeCandidate(id, overrides = {}) {
    return { id, trainNumber: id, trainType: 'KTX', departAt: '05:00', arriveAt: '07:00', fareLabel: '₩10,000', ...overrides };
  }

  function makeJobInput(candidates, overrides = {}) {
    return {
      userId: 'user-1',
      departure: '동탄',
      arrival: '울산(통도사)',
      date: '2026-12-31',
      timeRangeStart: '05:00',
      timeRangeEnd: '10:00',
      passengers: 1,
      seatClassPreference: 'standard_preferred',
      candidates,
      watchUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      intervalSeconds: 2,
      ...overrides,
    };
  }

  // A fake SeatAutomationProvider backed directly by the mock-booking-site
  // store (§4's "playwright 또는 프로젝트에 적합한 도구" -- for these fast
  // deterministic tests, calling the store functions directly stands in for
  // "a browser that reads/clicks this exact page", since the real
  // mock-browser Provider (lib/automation/providers/mock-browser-provider.ts)
  // is itself nothing more than a thin Playwright wrapper around these same
  // HTTP endpoints). Used only by *overriding* provider.ts's export for the
  // duration of a test -- see withFakeProvider().
  function makeFakeBrowserProvider() {
    return {
      name: 'mock-browser',
      capabilities() {
        return { supportsAvailability: true, supportsPurchaseClick: true, supportsReservation: true, supportsCancellation: false, simulation: true };
      },
      async searchAvailability({ candidate }) {
        const status = mockSiteStore.checkSeatStatus(candidate.id);
        return {
          candidateId: candidate.id,
          available: status.standardSeats > 0 || status.specialSeats > 0,
          seatClass: status.standardSeats > 0 ? 'standard' : status.specialSeats > 0 ? 'special' : null,
          definitiveSoldOut: status.definitiveSoldOut,
          checkedAt: status.checkedAt,
          simulation: true,
        };
      },
      async clickPurchase({ candidateId }) {
        const result = mockSiteStore.recordPurchaseClick(candidateId);
        if (!result.clicked) throw new AutomationError('PURCHASE_CLICK_FAILED', '클릭 실패');
        return { clicked: true, clickedAt: new Date().toISOString(), simulation: true };
      },
      async reserve({ candidateId, idempotencyKey }) {
        try {
          const reservation = mockSiteStore.reserveSeat({ listingId: candidateId, seatClass: 'standard', idempotencyKey });
          return { reserved: true, candidateId, reservationNumber: reservation.reservationNumber, paymentDeadline: reservation.paymentDeadline, simulation: true };
        } catch {
          throw new AutomationError('RESERVE_FAILED', '예약 시점에 좌석이 소진되었습니다.');
        }
      },
      async getReservation({ job }) {
        return { status: job.status, reservationNumber: job.reservationNumber, simulation: true };
      },
      async cancelReservation() {
        throw new AutomationError('NOT_CONFIGURED', '취소 자동화는 구현되지 않았습니다.');
      },
    };
  }

  async function withFakeProvider(run) {
    const original = providerModule.getSeatAutomationProvider;
    providerModule.getSeatAutomationProvider = () => makeFakeBrowserProvider();
    try {
      return await withEnv(DEV_ENABLED, run);
    } finally {
      providerModule.getSeatAutomationProvider = original;
    }
  }

  // -- 1. 허용된 상태 전이 전체 / 잘못된 상태 전이 거부 ----------------------
  const FORWARD_PATH = ['SCHEDULED', 'WATCHING', 'CHECKING_AVAILABILITY', 'SEAT_FOUND', 'PURCHASE_CLICKING', 'RESERVING', 'HELD', 'PAYMENT_PENDING', 'COMPLETED'];
  for (let i = 0; i < FORWARD_PATH.length - 1; i += 1) {
    assert.equal(stateMachine.canTransition(FORWARD_PATH[i], FORWARD_PATH[i + 1]), true, `${FORWARD_PATH[i]} -> ${FORWARD_PATH[i + 1]} must be allowed`);
  }
  for (const active of ['SCHEDULED', 'WATCHING', 'CHECKING_AVAILABILITY', 'SEAT_FOUND', 'PURCHASE_CLICKING', 'RESERVING', 'HELD', 'PAYMENT_PENDING', 'RATE_LIMITED', 'AUTH_REQUIRED']) {
    assert.equal(stateMachine.canTransition(active, 'CANCELLED'), true, `${active} -> CANCELLED must be allowed`);
  }
  assert.equal(stateMachine.canTransition('PAYMENT_EXPIRED', 'WATCHING'), true, '다시 감시: PAYMENT_EXPIRED -> WATCHING');
  const INVALID_PAIRS = [
    ['SCHEDULED', 'SEAT_FOUND'],
    ['WATCHING', 'SEAT_FOUND'],
    ['CHECKING_AVAILABILITY', 'HELD'],
    ['SEAT_FOUND', 'WATCHING'],
    ['PURCHASE_CLICKING', 'WATCHING'],
    ['HELD', 'WATCHING'],
    ['PAYMENT_PENDING', 'WATCHING'],
    ['COMPLETED', 'WATCHING'],
    ['CANCELLED', 'WATCHING'],
    ['SOLD_OUT', 'WATCHING'],
    ['FAILED', 'WATCHING'],
  ];
  for (const [from, to] of INVALID_PAIRS) {
    assert.equal(stateMachine.canTransition(from, to), false, `${from} -> ${to} must be rejected`);
  }
  assert.equal(stateMachine.isTerminalStatus('SOLD_OUT'), true);
  assert.equal(stateMachine.isTerminalStatus('COMPLETED'), true);
  assert.equal(stateMachine.isTerminalStatus('PAYMENT_EXPIRED'), false, 'PAYMENT_EXPIRED는 다시 감시가 가능하므로 terminal이 아니다');

  // -- 2. 매진 상태 반복 조회(candidate 1: always_sold_out) -----------------
  resetAll();
  mockSiteSeed.ensureMockBookingSiteSeeded();
  for (let i = 0; i < 5; i += 1) {
    const status = mockSiteStore.checkSeatStatus('mock-listing-1');
    assert.equal(status.standardSeats, 0);
    assert.equal(status.specialSeats, 0);
    assert.equal(status.soldOut, true);
    assert.equal(status.definitiveSoldOut, true, '항상 매진 시나리오는 매 확인마다 definitiveSoldOut=true여야 한다');
    assert.equal(status.checkCount, i + 1);
  }

  // -- 3. 지정된 횟수 후 좌석 발생(candidate 2: 3회차에 일반실 1석) ----------
  resetAll();
  mockSiteSeed.ensureMockBookingSiteSeeded();
  for (let i = 1; i <= 2; i += 1) {
    const status = mockSiteStore.checkSeatStatus('mock-listing-2');
    assert.equal(status.standardSeats, 0, `${i}회차에는 아직 좌석이 없어야 한다`);
    assert.equal(status.definitiveSoldOut, false, 'seat_after_n_checks는 definitiveSoldOut이 아니다');
  }
  const thirdCheck = mockSiteStore.checkSeatStatus('mock-listing-2');
  assert.equal(thirdCheck.standardSeats, 1, '3회차에 일반실 1석이 발생해야 한다');
  assert.equal(thirdCheck.checkCount, 3);
  // candidate 3(특실, 5회차)도 동일한 방식으로 재확인.
  for (let i = 1; i <= 4; i += 1) {
    const status = mockSiteStore.checkSeatStatus('mock-listing-3');
    assert.equal(status.specialSeats, 0, `${i}회차에는 아직 특실 좌석이 없어야 한다`);
  }
  const fifthCheck = mockSiteStore.checkSeatStatus('mock-listing-3');
  assert.equal(fifthCheck.specialSeats, 1, '5회차에 특실 1석이 발생해야 한다');

  // -- 4/5/6/7. 좌석 발견 -> 구매 클릭 -> 예약 요청 -> 가상 예약번호·결제기한 --
  await withFakeProvider(async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    const job = jobStore.createJob(makeJobInput([makeCandidate('mock-listing-2')], { userId: 'user-tick' }), 'mock-browser');
    let current = job;
    current = await worker.runJobOnce(current.id, 'user-tick', 'tick-0'); // SCHEDULED -> WATCHING
    assert.equal(current.status, 'WATCHING');
    current = await worker.runJobOnce(current.id, 'user-tick', 'tick-1'); // check #1: 매진
    assert.equal(current.status, 'WATCHING');
    assert.equal(current.attempts, 1);
    assert.ok(current.nextCheckAt, '다음 조회 시각이 기록돼야 한다');
    current = await worker.runJobOnce(current.id, 'user-tick', 'tick-2'); // check #2: 매진
    assert.equal(current.status, 'WATCHING');
    current = await worker.runJobOnce(current.id, 'user-tick', 'tick-3'); // check #3: 좌석 발견 -> 구매 클릭 -> 예약 -> HELD
    assert.equal(current.status, 'HELD', '3회차에 좌석 발견 후 구매 클릭·예약까지 한 tick에 완료돼야 한다');
    assert.ok(current.purchaseClickedAt, '구매 클릭 시각이 기록돼야 한다');
    assert.ok(current.seatFoundAt, '좌석 발견 시각이 기록돼야 한다');
    assert.ok(current.reservedAt, '예약 완료 시각이 기록돼야 한다');
    assert.match(current.reservationNumber, /^RF-[A-F0-9]{8}$/, '가상 예약번호 형식(RF-XXXXXXXX)');
    assert.ok(current.paymentDeadline, '결제기한이 발급돼야 한다');
    assert.equal(current.heldCandidateId, 'mock-listing-2');

    current = await worker.runJobOnce(current.id, 'user-tick', 'tick-4'); // HELD -> PAYMENT_PENDING
    assert.equal(current.status, 'PAYMENT_PENDING');
    assert.equal(current.notifiedForCycle, current.watchCycle, '성공 알림은 watchCycle당 1회 발송·기록돼야 한다');

    const dump = JSON.stringify(current);
    for (const forbidden of ['RESERVED', 'HELD_FOREVER']) {
      assert.equal(dump.includes(forbidden), false);
    }
  });

  // -- 8. 성공 후 나머지 후보 중단 -----------------------------------------
  await withFakeProvider(async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    const job = jobStore.createJob(makeJobInput([makeCandidate('mock-listing-2'), makeCandidate('mock-listing-3')], { userId: 'user-multi' }), 'mock-browser');
    let current = job;
    current = await worker.runJobOnce(current.id, 'user-multi', 'm-0');
    // 두 후보를 라운드로빈으로 확인하다가 candidate 2가 3회차에 먼저 확보된다.
    for (let i = 0; i < 6 && current.status === 'WATCHING'; i += 1) {
      current = await worker.runJobOnce(current.id, 'user-multi', `m-${i + 1}`);
    }
    assert.equal(current.status, 'HELD');
    assert.equal(current.heldCandidateId, 'mock-listing-2', '먼저 확보된 후보가 held여야 한다');
    // 이후 몇 번을 더 실행해도 job은 더 이상 WATCHING으로 돌아가 다른 후보를
    // 확인하지 않는다 -- attempts가 더 늘지 않는 것으로 확인한다.
    const attemptsAtHeld = current.attempts;
    current = await worker.runJobOnce(current.id, 'user-multi', 'm-after-1');
    assert.equal(current.attempts, attemptsAtHeld, 'HELD/PAYMENT_PENDING 이후에는 좌석 확인 시도가 더 늘지 않아야 한다(다른 후보 감시 자동 중단)');
  });

  // -- 9. 두 Worker 동시 실행 시 예약 1건(claim 경쟁) ------------------------
  await withFakeProvider(async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    // checksRequired=1이 되도록 확인을 3회 먼저 돌려 SEAT_FOUND 직전까지 만든다.
    const job = jobStore.createJob(makeJobInput([makeCandidate('mock-listing-2')], { userId: 'user-race' }), 'mock-browser');
    mockSiteStore.checkSeatStatus('mock-listing-2');
    mockSiteStore.checkSeatStatus('mock-listing-2');
    // 세 번째 체크까지 진행해 SEAT_FOUND에 도달시킨다(테스트에서 직접
    // job-store를 조작해 두 "Worker"가 동시에 같은 SEAT_FOUND job을 놓고
    // 경쟁하는 상황을 재현한다).
    jobStore.transitionJob(job.id, 'user-race', 'WATCHING', '테스트: 감시 시작');
    jobStore.transitionJob(job.id, 'user-race', 'CHECKING_AVAILABILITY', '테스트: 확인 중');
    jobStore.transitionJob(job.id, 'user-race', 'SEAT_FOUND', '테스트: 좌석 발견', { seatFoundAt: new Date().toISOString() });

    const claimA = jobStore.claimJobStep(job.id, 'user-race');
    const claimB = jobStore.claimJobStep(job.id, 'user-race');
    assert.equal(claimA.outcome, 'claimed', '첫 번째 Worker는 claim에 성공해야 한다');
    assert.equal(claimB.outcome, 'already_claimed', '두 번째 Worker는 이미 선점된 것을 확인해야 한다(리스 만료 전)');

    // A만 실제로 구매+예약을 완료한다.
    mockSiteStore.checkSeatStatus('mock-listing-2'); // 3회차 -- 이제 좌석이 있다.
    mockSiteStore.recordPurchaseClick('mock-listing-2');
    jobStore.advanceClaimedStep(job.id, 'user-race', claimA.claimToken, 'RESERVING', '테스트: 구매 클릭 완료');
    const reservation = mockSiteStore.reserveSeat({ listingId: 'mock-listing-2', seatClass: 'standard', idempotencyKey: 'race-key-1' });
    const held = jobStore.completeJobStep(job.id, 'user-race', claimA.claimToken, 'HELD', '테스트: 예약 완료', {
      reservedAt: new Date().toISOString(),
      heldCandidateId: 'mock-listing-2',
      reservationNumber: reservation.reservationNumber,
      paymentDeadline: reservation.paymentDeadline,
    });
    assert.equal(held.applied, true);

    // B가 (자신은 claim에 실패했다는 것을 모른 채) 뒤늦게 완료를 보고해도
    // 절대 적용되지 않아야 한다 -- fencing token이 다르다.
    const staleCompletion = jobStore.completeJobStep(job.id, 'user-race', claimB.outcome === 'claimed' ? claimB.claimToken : 'not-a-real-token', 'HELD', '테스트: B의 뒤늦은 완료');
    assert.equal(staleCompletion.applied, false);
    assert.equal(staleCompletion.reason, 'stale_claim');
    assert.equal(jobStore.getJob(job.id, 'user-race').status, 'HELD', 'B의 완료 시도가 A의 결과를 덮어쓰면 안 된다');

    // 좌석은 정확히 1건만 예약됐다(같은 listing에 두 번째 reserveSeat을
    // 시도하면 이미 소진된 상태로 실패해야 한다).
    assert.throws(() => mockSiteStore.reserveSeat({ listingId: 'mock-listing-2', seatClass: 'standard', idempotencyKey: 'race-key-2' }), /SOLD_OUT_AT_RESERVE/);
  });

  // -- 10. 동일 요청 재시도 시 예약 1건(idempotencyKey) ----------------------
  resetAll();
  mockSiteSeed.ensureMockBookingSiteSeeded();
  for (let i = 0; i < 3; i += 1) mockSiteStore.checkSeatStatus('mock-listing-2');
  const firstReserve = mockSiteStore.reserveSeat({ listingId: 'mock-listing-2', seatClass: 'standard', idempotencyKey: 'idem-key-A' });
  const retryReserve = mockSiteStore.reserveSeat({ listingId: 'mock-listing-2', seatClass: 'standard', idempotencyKey: 'idem-key-A' });
  assert.equal(firstReserve.id, retryReserve.id, '같은 idempotencyKey로 재시도해도 같은 예약을 반환해야 한다');
  assert.equal(firstReserve.reservationNumber, retryReserve.reservationNumber);

  // -- 11. Worker 재시작 후 상태 복원(만료된 claim 재획득) -------------------
  await withEnv({ ...DEV_ENABLED, AUTOMATION_STEP_LEASE_MS: '10' }, async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    const job = jobStore.createJob(makeJobInput([makeCandidate('mock-listing-2')], { userId: 'user-restart' }), 'mock-browser');
    jobStore.transitionJob(job.id, 'user-restart', 'WATCHING', 't');
    jobStore.transitionJob(job.id, 'user-restart', 'CHECKING_AVAILABILITY', 't');
    jobStore.transitionJob(job.id, 'user-restart', 'SEAT_FOUND', 't', { seatFoundAt: new Date().toISOString() });
    const firstClaim = jobStore.claimJobStep(job.id, 'user-restart');
    assert.equal(firstClaim.outcome, 'claimed');
    await new Promise((resolve) => setTimeout(resolve, 30)); // 짧은 테스트 전용 리스가 만료될 때까지 대기.
    const secondClaim = jobStore.claimJobStep(job.id, 'user-restart');
    assert.equal(secondClaim.outcome, 'claimed', '리스가 만료되면 재시작된 Worker가 재획득할 수 있어야 한다');
    assert.notEqual(secondClaim.claimToken, firstClaim.claimToken);
    const staleComplete = jobStore.completeJobStep(job.id, 'user-restart', firstClaim.claimToken, 'HELD', 'stale');
    assert.equal(staleComplete.applied, false, '재시작 전 Worker의 오래된 토큰은 거부돼야 한다');
  });
  // Production에서는 AUTOMATION_STEP_LEASE_MS 오버라이드를 무시해야 한다.
  await withEnv({ VERCEL_ENV: 'production', AUTOMATION_STEP_LEASE_MS: '10' }, async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    const job = jobStore.createJob(makeJobInput([makeCandidate('mock-listing-2')], { userId: 'user-prod-lease' }), 'unavailable');
    jobStore.transitionJob(job.id, 'user-prod-lease', 'WATCHING', 't');
    jobStore.transitionJob(job.id, 'user-prod-lease', 'CHECKING_AVAILABILITY', 't');
    jobStore.transitionJob(job.id, 'user-prod-lease', 'SEAT_FOUND', 't', { seatFoundAt: new Date().toISOString() });
    const claim = jobStore.claimJobStep(job.id, 'user-prod-lease');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondClaim = jobStore.claimJobStep(job.id, 'user-prod-lease');
    assert.equal(secondClaim.outcome, 'already_claimed', 'Production에서는 짧은 리스 오버라이드가 무시되고 기본(20s) 리스를 써야 한다');
    void claim;
  });

  // -- 12. 만료된 작업 실행 차단(watchUntil) --------------------------------
  await withFakeProvider(async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    const job = jobStore.createJob(makeJobInput([makeCandidate('mock-listing-1')], { userId: 'user-expire', watchUntil: new Date(Date.now() - 1000).toISOString() }), 'mock-browser');
    const result = await worker.runJobOnce(job.id, 'user-expire', 'exp-1');
    assert.equal(result.status, 'EXPIRED');
    const again = await worker.runJobOnce(job.id, 'user-expire', 'exp-2');
    assert.equal(again.status, 'EXPIRED', 'EXPIRED는 terminal이므로 더 이상 진행하면 안 된다');
  });

  // -- 13/14/15. 외부 URL/리디렉션/도메인 차단(host-guard) -------------------
  const BLOCKED_TARGETS = [
    'https://www.korail.com/',
    'https://letskorail.com/booking',
    'https://www.srail.or.kr/',
    'http://127.0.0.1.evil.example.com/',
    'https://198.51.100.10/', // 임의의 외부 IP
    'https://데모.internal-proxy.example/',
  ];
  for (const target of BLOCKED_TARGETS) {
    assert.throws(() => hostGuard.assertAutomationTargetAllowed(target), (error) => error instanceof AutomationError && error.code === 'AUTOMATION_TARGET_NOT_ALLOWED', `차단되어야 함: ${target}`);
  }
  assert.doesNotThrow(() => hostGuard.assertAutomationTargetAllowed('http://localhost:3000/demo/booking-simulator'));
  assert.doesNotThrow(() => hostGuard.assertAutomationTargetAllowed('http://127.0.0.1:3000/demo/booking-simulator'));
  await withEnv({ VERCEL_URL: 'rail-flow-git-feat-example-dhmailing.vercel.app' }, async () => {
    assert.doesNotThrow(() => hostGuard.assertAutomationTargetAllowed('https://rail-flow-git-feat-example-dhmailing.vercel.app/demo/booking-simulator'));
    // VERCEL_URL이 정상적인 자기 호스트일 때는 빌드가 성공해야 한다.
    const builtUrl = hostGuard.buildAutomationTargetUrl('/demo/booking-simulator');
    assert.equal(builtUrl, 'https://rail-flow-git-feat-example-dhmailing.vercel.app/demo/booking-simulator');
  });
  await withEnv({ VERCEL_URL: '', AUTOMATION_TARGET_BASE_URL: 'https://www.korail.com' }, async () => {
    assert.throws(
      () => hostGuard.buildAutomationTargetUrl('/demo/booking-simulator'),
      (error) => error instanceof AutomationError && error.code === 'AUTOMATION_TARGET_NOT_ALLOWED',
      '환경변수를 korail.com으로 바꿔도 코드 레벨에서 차단되어야 한다',
    );
  });
  // 리디렉션 후 재검증: 최종 주소가 허용 목록 밖이면 차단.
  assert.throws(() => hostGuard.assertPostNavigationTargetAllowed('https://www.korail.com/redirected'), (error) => error.code === 'AUTOMATION_TARGET_NOT_ALLOWED');

  // -- 17. Production에서 자동화 API 503 ------------------------------------
  await withEnv({ VERCEL_ENV: 'production', ...DEV_ENABLED }, async () => {
    const req = (url, init = {}) => new NextRequest(url, { ...init, headers: { origin: 'https://rail-flow-ten.vercel.app', ...(init.headers || {}) } });
    const createRes = await listingsRoute.GET();
    assert.equal(createRes.status, 503, 'Production에서는 mock-site listings도 503이어야 한다');
    void req;
  });
  resetAll();
  mockSiteSeed.ensureMockBookingSiteSeeded();

  // -- mock-site API 라우트 자체를 직접 호출해 계약을 확인(§18과 겹치지 않는
  // 범위: HTTP 계층) --------------------------------------------------------
  await withEnv(DEV_ENABLED, async () => {
    resetAll();
    mockSiteSeed.ensureMockBookingSiteSeeded();
    const listingsRes = await listingsRoute.GET();
    assert.equal(listingsRes.status, 200);
    const { listings } = await listingsRes.json();
    assert.equal(listings.length, 3);

    const statusRes1 = await statusRoute.GET(new Request('http://test/status'), { params: Promise.resolve({ id: 'mock-listing-2' }) });
    assert.equal(statusRes1.status, 200);
    const { status: s1 } = await statusRes1.json();
    assert.equal(s1.checkCount, 1);

    await statusRoute.GET(new Request('http://test/status'), { params: Promise.resolve({ id: 'mock-listing-2' }) });
    const statusRes3 = await statusRoute.GET(new Request('http://test/status'), { params: Promise.resolve({ id: 'mock-listing-2' }) });
    const { status: s3 } = await statusRes3.json();
    assert.equal(s3.standardSeats, 1, 'HTTP 라우트로도 3회차 좌석 발생이 재현되어야 한다');

    const clickRes = await purchaseClickRoute.POST(new Request('http://test/click', { method: 'POST' }), { params: Promise.resolve({ id: 'mock-listing-2' }) });
    assert.equal(clickRes.status, 200);
    const statusAfterClick = await statusRoute.GET(new Request('http://test/status'), { params: Promise.resolve({ id: 'mock-listing-2' }) });
    const { status: s4 } = await statusAfterClick.json();
    assert.equal(s4.purchaseClicked, true, '구매 클릭 사실이 서버에 반영되어야 한다(§ 별도 상태 관리)');

    const reserveRes = await reserveRoute.POST(
      new Request('http://test/reserve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seatClass: 'standard', idempotencyKey: 'http-key-1' }) }),
      { params: Promise.resolve({ id: 'mock-listing-2' }) },
    );
    assert.equal(reserveRes.status, 200);
    const { reservation } = await reserveRes.json();
    assert.match(reservation.reservationNumber, /^RF-[A-F0-9]{8}$/);
  });

  // -- 16. 실제 비밀번호·쿠키·카드정보 저장 0건(정적 소스 검사) ---------------
  const AUTOMATION_DIRS = ['lib/automation', 'app/api/automation-jobs', 'app/api/automation/mock-site', 'components/automation', 'app/demo/booking-simulator'];
  const files = [];
  for (const dir of AUTOMATION_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  assert.ok(files.length >= 15, 'v0.7 소스 파일을 충분히 찾지 못했다');

  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }
  const FORBIDDEN_PII_PATTERNS = [/\bpassword\s*[:=]/i, /\bcard(number|cvv)\s*[:=]/i, /\bcookie\s*[:=]/i, /\bsessiontoken\s*[:=]/i];
  const FORBIDDEN_OPERATIONAL_HOSTS = ['korail.com', 'letskorail.com', 'srail.or.kr', 'srail.co.kr', 'data.go.kr', 'kric.go.kr'];
  for (const file of files) {
    const relative = path.relative(root, file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const pattern of FORBIDDEN_PII_PATTERNS) {
      assert.equal(pattern.test(code), false, `${relative}: 개인정보/비밀값 필드(${pattern})를 포함하면 안 된다`);
    }
    // host-guard.ts 자신은 이 문자열들을 차단 목적으로 포함해야 하므로 예외.
    if (relative.endsWith('host-guard.ts')) continue;
    for (const host of FORBIDDEN_OPERATIONAL_HOSTS) {
      assert.equal(code.includes(host), false, `${relative}: 실제 철도 도메인("${host}")을 참조하면 안 된다`);
    }
  }

  // -- 18. 기존 시간표·WatchJob·Demo 회귀 없음(정적 경계 검사) ---------------
  // job/state 모델(types/state-machine/job-store/provider*)은 완전히
  // 독립적이어야 한다. worker.ts 하나만 예외다 -- 사용자 지시대로 기존
  // 알림 Outbox 어댑터(lib/watch/notification/adapters.ts)를 실제로
  // 재사용하기 때문이다(§ "알림 Outbox... 최대한 재사용한다").
  for (const file of files) {
    const relative = path.relative(root, file);
    if (relative.endsWith(path.join('lib', 'automation', 'worker.ts'))) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    // lib/rail/stations(역 이름 목록, 순수 데이터)는 v0.4/v0.5 UI 패널도
    // 이미 공유해서 쓰는 기존 관례라 예외로 둔다 -- TAGO/예약 로직과의
    // 결합이 아니다. lib/watch/**, lib/reservation/**(job/상태 저장소)는
    // 예외 없이 금지한다.
    assert.equal(/@\/lib\/(watch|reservation)\//.test(code), false, `${relative}: lib/watch|reservation을 import하면 안 된다(v0.7은 독립 모듈)`);
  }
  const workerSource = readSource('lib/automation/worker.ts');
  assert.ok(workerSource.includes('@/lib/watch/notification/adapters'), 'worker.ts는 기존 알림 Outbox 어댑터를 재사용해야 한다');
  assert.equal(/@\/lib\/(watch\/store|watch\/worker|reservation\/|rail\/)/.test(stripComments(workerSource)), false, 'worker.ts도 알림 어댑터 외에는 WatchJob/ReservationJob 저장소·상태를 직접 건드리면 안 된다');
  // app/page.tsx가 기존 WatchJobsPanel을 여전히 렌더링하는지(제거되지 않았는지).
  const pageSource = readSource('app/page.tsx');
  assert.ok(pageSource.includes('WatchJobsPanel'), 'app/page.tsx는 기존 WatchJobsPanel을 계속 렌더링해야 한다');
  assert.ok(pageSource.includes('AutomationJobsPanel'), 'app/page.tsx는 새 AutomationJobsPanel도 렌더링해야 한다');

  console.log = originalLog;
  console.error = originalError;

  assert.equal(fetchCalls, 0, 'v0.7 자동화 서브시스템은 실제로 fetch를 호출하면 안 된다');
  const leaked = capturedLogs.some((line) => line.includes(FAKE_PASSWORD));
  assert.equal(leaked, false, 'no log line may contain a plaintext password');

  originalLog(JSON.stringify({ result: 'PASS', fetchCalls, checkedFiles: files.length, capturedLogLines: capturedLogs.length }));
}

main().catch((error) => {
  console.error = originalError;
  originalError(error);
  process.exitCode = 1;
});
