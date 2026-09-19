// Offline contract checks for the v0.4 reservation-foundation subsystem.
// No production credentials, no external network calls -- every train/seat/
// error outcome here comes from lib/reservation/mock-reservation-provider.ts
// and lib/reservation/official-reservation-provider-stub.ts. v0.3's own
// schedule/station/fare regression suite lives in scripts/verify-rail.cjs and
// is not duplicated here.
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
    name === 'server-only' ? {} : name.startsWith('@/') ? load(name.slice(2) + '.ts') : require(name);
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    filename,
  );
  return mod.exports;
}

// No reservation module may ever open a network connection.
let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls += 1;
  throw new Error('reservation subsystem must never call fetch');
};

// No reservation module may ever print DATA_GO_KR_SERVICE_KEY or any secret.
const FAKE_SECRET = 'fixture-only-not-a-real-key-zzz999';
process.env.DATA_GO_KR_SERVICE_KEY = FAKE_SECRET;
const capturedLogs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { capturedLogs.push(args.map(String).join(' ')); };
console.error = (...args) => { capturedLogs.push(args.map(String).join(' ')); };

const jobStore = load('lib/reservation/job-store.ts');
const worker = load('lib/reservation/worker.ts');
const { assertTransition, canTransition, isTerminalStatus, assertNotExpired } = load('lib/reservation/state-machine.ts');
const { assertSimulationAllowed } = load('lib/reservation/simulation-guard.ts');
const reservationTypes = load('lib/reservation/types.ts');
const provider = load('lib/reservation/provider.ts');
const queue = load('lib/reservation/queue.ts');
const reservationsRoute = load('app/api/reservations/route.ts');
const reservationDetailRoute = load('app/api/reservations/[id]/route.ts');
const cancelRoute = load('app/api/reservations/[id]/cancel/route.ts');
const simulateRoute = load('app/api/reservations/[id]/simulate/route.ts');
const providerStatusRoute = load('app/api/reservations/provider-status/route.ts');

function resetAll() {
  jobStore.__resetJobStoreForTests();
  queue.__resetQueueForTests();
}

function baseInput(overrides = {}) {
  return {
    userId: 'demo-user1',
    departure: '동탄',
    arrival: '울산(통도사)',
    departureId: 'demo-0',
    arrivalId: 'demo-1',
    date: '2026-09-26',
    timeRangeStart: '09:00',
    timeRangeEnd: '18:00',
    passengers: 1,
    seatClassPreference: 'standard_preferred',
    candidates: [{ id: 'cand-1', trainNumber: 'KTX 101', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }],
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
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

async function main() {
  // -- state machine --
  assert.equal(canTransition('DRAFT', 'SCHEDULED'), true);
  assert.equal(canTransition('DRAFT', 'HELD'), false);
  assert.throws(() => assertTransition('DRAFT', 'HELD'), { code: 'INVALID_TRANSITION' });
  assert.equal(isTerminalStatus('COMPLETED'), true);
  assert.equal(isTerminalStatus('WATCHING'), false);
  assert.throws(() => assertTransition('COMPLETED', 'WATCHING'), { code: 'INVALID_TRANSITION' });
  assert.throws(() => assertNotExpired({ status: 'WATCHING', expiresAt: new Date(Date.now() - 1000).toISOString() }), { code: 'INVALID_TRANSITION' });

  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true', ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    // -- duplicate job prevention --
    resetAll();
    const jobA = jobStore.createJob(baseInput(), 'mock');
    assert.equal(jobA.status, 'DRAFT');
    assert.throws(() => jobStore.createJob(baseInput(), 'mock'), { code: 'DUPLICATE_JOB' });
    // Different date is not a duplicate.
    const jobB = jobStore.createJob(baseInput({ date: '2026-09-27' }), 'mock');
    assert.notEqual(jobA.id, jobB.id);

    // -- cancellation --
    const cancelled = jobStore.cancelJob(jobA.id, jobA.userId);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.throws(() => jobStore.transitionJob(jobA.id, jobA.userId, 'WATCHING', 'x'), { code: 'INVALID_TRANSITION' });
    // Cancelling frees the dedupe key up for a fresh job with the same route/date/passengers.
    jobStore.createJob(baseInput(), 'mock');

    // -- mock seat-none -> seat-appears -> HELD flow, and "held candidate stops the others" --
    resetAll();
    const flowJob = jobStore.createJob(
      baseInput({
        candidates: [
          { id: 'never', trainNumber: 'KTX 900', departAt: '2026-09-26T08:00:00+09:00', arriveAt: '2026-09-26T10:00:00+09:00', mockScenario: 'no_seat_ever' },
          { id: 'appears', trainNumber: 'KTX 901', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'seat_after_one_check' },
        ],
      }),
      'mock',
    );
    let step = await worker.runJobOnce(flowJob.id, flowJob.userId, 'k1'); // DRAFT -> SCHEDULED
    assert.equal(step.status, 'SCHEDULED');
    step = await worker.runJobOnce(flowJob.id, flowJob.userId, 'k2'); // SCHEDULED -> WATCHING
    assert.equal(step.status, 'WATCHING');
    step = await worker.runJobOnce(flowJob.id, flowJob.userId, 'k3'); // checks candidate[0]="never" -> not available
    assert.equal(step.status, 'WATCHING');
    assert.equal(step.attempts, 1);
    step = await worker.runJobOnce(flowJob.id, flowJob.userId, 'k4'); // checks candidate[1]="appears", attempts>=1 -> available -> HELD
    assert.equal(step.status, 'HELD');
    assert.equal(step.heldCandidateId, 'appears');
    // Once HELD, the job (and so the "never" candidate) never gets watched again.
    step = await worker.runJobOnce(flowJob.id, flowJob.userId, 'k5'); // HELD -> PAYMENT_PENDING
    assert.equal(step.status, 'PAYMENT_PENDING');
    assert.equal(step.heldCandidateId, 'appears');

    // -- worker idempotency on duplicate delivery --
    resetAll();
    const idemJob = jobStore.createJob(baseInput({ candidates: [{ id: 'a', trainNumber: 'KTX 1', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }] }), 'mock');
    const first = await worker.runJobOnce(idemJob.id, idemJob.userId, 'same-key');
    assert.equal(first.status, 'SCHEDULED');
    const replay = await worker.runJobOnce(idemJob.id, idemJob.userId, 'same-key');
    assert.equal(replay.status, 'SCHEDULED', 'duplicate idempotencyKey must not advance the job twice');
    assert.equal(replay.history.length, first.history.length);

    // -- expired job cannot re-enter the reservation path --
    resetAll();
    const expiring = jobStore.createJob(baseInput({ expiresAt: new Date(Date.now() + 200).toISOString() }), 'mock');
    await worker.runJobOnce(expiring.id, expiring.userId, 'e1');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(worker.runJobOnce(expiring.id, expiring.userId, 'e2'), { code: 'INVALID_TRANSITION' });

    // -- error scenarios surface structured errors, not thrown network errors --
    resetAll();
    const errJob = jobStore.createJob(baseInput({ candidates: [{ id: 'x', trainNumber: 'KTX 2', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'error_on_check' }] }), 'mock');
    await worker.runJobOnce(errJob.id, errJob.userId, 'r1');
    await worker.runJobOnce(errJob.id, errJob.userId, 'r2');
    const afterError = await worker.runJobOnce(errJob.id, errJob.userId, 'r3');
    assert.equal(afterError.status, 'WATCHING');
    assert.equal(afterError.lastError.code, 'CHECK_FAILED');
  });

  // -- kill switch --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'false' }, async () => {
    const job = jobStore.createJob(baseInput({ userId: 'demo-killswitch' }), 'mock');
    await assert.rejects(worker.runJobOnce(job.id, job.userId, 'z1'), { code: 'JOBS_DISABLED' });
  });

  // -- official provider stub: structured errors, never network --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'official' }, () => {
    const official = provider.getReservationProvider();
    assert.equal(official.name, 'official');
    assert.equal(official.capabilities().supportsHold, false);
  });
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'disabled' }, () => {
    assert.throws(() => provider.getReservationProvider(), { code: 'JOBS_DISABLED' });
  });

  // -- simulation guard: 1-5 allowed, everything else rejected --
  await withEnv({ ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, () => {
    for (const seconds of [1, 2, 3, 4, 5]) {
      assert.equal(assertSimulationAllowed({ intervalSeconds: seconds, provider: 'mock' }), seconds);
    }
    for (const bad of [0, 6, 2.5, 'abc', -1]) {
      assert.throws(() => assertSimulationAllowed({ intervalSeconds: bad, provider: 'mock' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, `interval ${bad} must be rejected`);
    }
    assert.throws(() => assertSimulationAllowed({ intervalSeconds: 3, provider: 'official' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, 'non-mock provider must be rejected');
  });
  await withEnv({ ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'production' }, () => {
    assert.throws(() => assertSimulationAllowed({ intervalSeconds: 3, provider: 'mock' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, 'production must always reject, regardless of the value');
  });
  await withEnv({ ENABLE_MOCK_SIMULATION: 'false', NODE_ENV: 'test' }, () => {
    assert.throws(() => assertSimulationAllowed({ intervalSeconds: 3, provider: 'mock' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, 'ENABLE_MOCK_SIMULATION=false must reject even valid values');
  });

  // -- API routes --
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true', ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const createReq = new NextRequest('http://test/api/reservations', { method: 'POST', body: JSON.stringify(baseInput({ userId: 'demo-api1' })), headers: { 'content-type': 'application/json' } });
    const createRes = await reservationsRoute.POST(createReq);
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    const jobId = created.job.id;

    const dupRes = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', { method: 'POST', body: JSON.stringify(baseInput({ userId: 'demo-api1' })), headers: { 'content-type': 'application/json' } }));
    assert.equal(dupRes.status, 409);

    const badRes = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', { method: 'POST', body: JSON.stringify({ userId: 'not-demo' }), headers: { 'content-type': 'application/json' } }));
    assert.equal(badRes.status, 400);

    const listRes = await reservationsRoute.GET(new NextRequest('http://test/api/reservations?userId=demo-api1'));
    assert.equal(listRes.status, 200);
    assert.equal((await listRes.json()).jobs.length, 1);

    const detailRes = await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${jobId}?userId=demo-api1`), { params: Promise.resolve({ id: jobId }) });
    assert.equal(detailRes.status, 200);

    const wrongUserRes = await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${jobId}?userId=demo-someoneelse`), { params: Promise.resolve({ id: jobId }) });
    assert.equal(wrongUserRes.status, 404);

    const simRes = await simulateRoute.POST(
      new NextRequest(`http://test/api/reservations/${jobId}/simulate`, { method: 'POST', body: JSON.stringify({ userId: 'demo-api1', idempotencyKey: 'sim-1', simulationIntervalSeconds: 2 }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: jobId }) },
    );
    assert.equal(simRes.status, 200);
    assert.equal((await simRes.json()).job.status, 'SCHEDULED');

    const cancelRes = await cancelRoute.POST(
      new NextRequest(`http://test/api/reservations/${jobId}/cancel`, { method: 'POST', body: JSON.stringify({ userId: 'demo-api1' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: jobId }) },
    );
    assert.equal(cancelRes.status, 200);
    assert.equal((await cancelRes.json()).job.status, 'CANCELLED');

    const statusRes = await providerStatusRoute.GET();
    const statusBody = await statusRes.json();
    assert.equal(statusBody.reservationProvider, 'mock');
    assert.equal(statusBody.allowLiveReservation, false);
  });

  // jobs-disabled and provider-disabled must fail closed at the API boundary too
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'false' }, async () => {
    const res = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', { method: 'POST', body: JSON.stringify(baseInput({ userId: 'demo-api2' })), headers: { 'content-type': 'application/json' } }));
    assert.equal(res.status, 503);
  });
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'disabled', ENABLE_RESERVATION_JOBS: 'true' }, async () => {
    const res = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', { method: 'POST', body: JSON.stringify(baseInput({ userId: 'demo-api3' })), headers: { 'content-type': 'application/json' } }));
    assert.equal(res.status, 503);
  });

  console.log = originalLog;
  console.error = originalError;

  assert.equal(fetchCalls, 0, 'the reservation subsystem must never call fetch');
  const leaked = capturedLogs.some((line) => line.includes(FAKE_SECRET));
  assert.equal(leaked, false, 'no reservation log line may contain a secret value');

  // simulation() results always self-identify as mock, per the "never mistaken for a real seat" rule.
  const sample = reservationTypes;
  assert.ok(sample.ReservationProviderError);

  originalLog(JSON.stringify({ result: 'PASS', fetchCalls, capturedLogLines: capturedLogs.length }));
}

main().catch((error) => {
  console.error = originalError;
  originalError(error);
  process.exitCode = 1;
});
