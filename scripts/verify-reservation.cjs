// Offline contract checks for the v0.4 reservation-foundation subsystem.
// No production credentials, no external network calls -- every train/seat/
// error outcome here comes from lib/reservation/mock-reservation-provider.ts
// and lib/reservation/official-reservation-provider-stub.ts. v0.3's own
// schedule/station/fare regression suite lives in scripts/verify-rail.cjs and
// is not duplicated here.
//
// This file also covers the PR #7 pre-merge review fixes: the simulate route
// can no longer skip its guard, expiry is a persisted state (not a thrown
// exception), idempotency keys are scoped per job/user, PROVIDER_CHANGED is
// reachable from every active state without crashing on a repeat tick, the
// official Provider Stub is blocked at job creation, every Demo route (save
// provider-status) refuses to run in production, and the API/UI "simulation"
// contract is an explicit field on the job, not just on Provider results.
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
const { assertTransition, canTransition, isTerminalStatus, hasExpired } = load('lib/reservation/state-machine.ts');
const { assertSimulationAllowed } = load('lib/reservation/simulation-guard.ts');
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

// Each POST route has its own rate-limit bucket keyed by x-forwarded-for
// (falling back to "anonymous" otherwise), so unrelated test scenarios that
// each fire a handful of requests must use distinct client IDs -- otherwise
// they'd share one bucket and later scenarios would spuriously see 429s that
// have nothing to do with what they're actually testing.
function jsonBody(body, clientId = 'test-client') {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': clientId } };
}

async function main() {
  // -- state machine: basic transitions --
  assert.equal(canTransition('DRAFT', 'SCHEDULED'), true);
  assert.equal(canTransition('DRAFT', 'HELD'), false);
  assert.throws(() => assertTransition('DRAFT', 'HELD'), { code: 'INVALID_TRANSITION' });
  assert.equal(isTerminalStatus('COMPLETED'), true);
  assert.equal(isTerminalStatus('WATCHING'), false);
  assert.throws(() => assertTransition('COMPLETED', 'WATCHING'), { code: 'INVALID_TRANSITION' });

  // -- hasExpired is a pure predicate, not a throwing assertion --
  assert.equal(hasExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() }), true);
  assert.equal(hasExpired({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), false);

  // -- PROVIDER_CHANGED must be reachable from every active state, never from a terminal one --
  for (const from of ['DRAFT', 'SCHEDULED', 'WATCHING', 'RESERVING', 'HELD', 'PAYMENT_PENDING', 'RATE_LIMITED', 'AUTH_REQUIRED']) {
    assert.equal(canTransition(from, 'PROVIDER_CHANGED'), true, `${from} -> PROVIDER_CHANGED must be allowed`);
  }
  assert.equal(canTransition('PROVIDER_CHANGED', 'FAILED'), true);
  assert.equal(canTransition('PROVIDER_CHANGED', 'PROVIDER_CHANGED'), false, 'no state, including PROVIDER_CHANGED itself, transitions to itself');
  for (const terminal of ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED']) {
    assert.equal(canTransition(terminal, 'PROVIDER_CHANGED'), false, `${terminal} -> PROVIDER_CHANGED must stay blocked`);
  }

  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true', ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    // -- duplicate job prevention --
    resetAll();
    const jobA = jobStore.createJob(baseInput(), 'mock');
    assert.equal(jobA.status, 'DRAFT');
    assert.equal(jobA.simulation, true, 'a job created against the mock Provider must carry simulation:true');
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

    // -- mock seat-none -> seat-appears -> HELD flow, holdExpiresAt persistence, and
    // "held candidate stops the others" --
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
    assert.equal(flowJob.holdExpiresAt, null);
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
    assert.ok(step.holdExpiresAt, 'HELD must record holdExpiresAt from the Provider result');
    // Once HELD, the job (and so the "never" candidate) never gets watched again.
    step = await worker.runJobOnce(flowJob.id, flowJob.userId, 'k5'); // HELD -> PAYMENT_PENDING
    assert.equal(step.status, 'PAYMENT_PENDING');
    assert.equal(step.heldCandidateId, 'appears');
    assert.ok(step.holdExpiresAt, 'HELD -> PAYMENT_PENDING must not lose holdExpiresAt');

    // -- worker idempotency on duplicate delivery (same job, same key) --
    resetAll();
    const idemJob = jobStore.createJob(baseInput({ candidates: [{ id: 'a', trainNumber: 'KTX 1', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }] }), 'mock');
    const first = await worker.runJobOnce(idemJob.id, idemJob.userId, 'same-key');
    assert.equal(first.status, 'SCHEDULED');
    const replay = await worker.runJobOnce(idemJob.id, idemJob.userId, 'same-key');
    assert.equal(replay.status, 'SCHEDULED', 'duplicate idempotencyKey must not advance the job twice');
    assert.equal(replay.history.length, first.history.length);

    // -- error scenarios surface structured errors, not thrown network errors --
    resetAll();
    const errJob = jobStore.createJob(baseInput({ candidates: [{ id: 'x', trainNumber: 'KTX 2', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'error_on_check' }] }), 'mock');
    await worker.runJobOnce(errJob.id, errJob.userId, 'r1');
    await worker.runJobOnce(errJob.id, errJob.userId, 'r2');
    const afterError = await worker.runJobOnce(errJob.id, errJob.userId, 'r3');
    assert.equal(afterError.status, 'WATCHING');
    assert.equal(afterError.lastError.code, 'CHECK_FAILED');
  });

  // -- expiry is a persisted EXPIRED state, not a thrown exception, and replaying
  // an EXPIRED job is a total no-op (no Provider call, no state/history change) --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true' }, async () => {
    const expiring = jobStore.createJob(baseInput({ userId: 'demo-expire', expiresAt: new Date(Date.now() + 150).toISOString() }), 'mock');
    const scheduled = await worker.runJobOnce(expiring.id, expiring.userId, 'e1'); // before the deadline
    assert.equal(scheduled.status, 'SCHEDULED');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const expired = await worker.runJobOnce(expiring.id, expiring.userId, 'e2');
    assert.equal(expired.status, 'EXPIRED', 'a past-deadline job must be persisted as EXPIRED, not merely rejected');
    assert.equal(expired.history.at(-1).to, 'EXPIRED');
    const rerun = await worker.runJobOnce(expiring.id, expiring.userId, 'e3');
    assert.equal(JSON.stringify(rerun), JSON.stringify(expired), 'replaying an EXPIRED job must be a total no-op');
  });

  // -- PAYMENT_PENDING must NOT be auto-expired by the watch deadline (expiresAt);
  // holdExpiresAt-based expiry is explicitly out of scope for this PR --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true' }, async () => {
    const shortJob = jobStore.createJob(
      baseInput({
        userId: 'demo-short',
        expiresAt: new Date(Date.now() + 150).toISOString(),
        candidates: [{ id: 'c1', trainNumber: 'KTX 9', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }],
      }),
      'mock',
    );
    await worker.runJobOnce(shortJob.id, shortJob.userId, 's1'); // DRAFT -> SCHEDULED
    await worker.runJobOnce(shortJob.id, shortJob.userId, 's2'); // SCHEDULED -> WATCHING
    const held = await worker.runJobOnce(shortJob.id, shortJob.userId, 's3'); // -> HELD
    assert.equal(held.status, 'HELD');
    const pending = await worker.runJobOnce(shortJob.id, shortJob.userId, 's4'); // HELD -> PAYMENT_PENDING
    assert.equal(pending.status, 'PAYMENT_PENDING');
    await new Promise((resolve) => setTimeout(resolve, 200)); // now well past the watch deadline
    const stillPending = await worker.runJobOnce(shortJob.id, shortJob.userId, 's5');
    assert.equal(stillPending.status, 'PAYMENT_PENDING', 'PAYMENT_PENDING must not be auto-expired by expiresAt');
  });

  // -- PROVIDER_CHANGED reachable from HELD (not just WATCHING/RESERVING), and a
  // second tick after PROVIDER_CHANGED must not crash (no from===to transition) --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true' }, async () => {
    const pcJob = jobStore.createJob(
      baseInput({ userId: 'demo-pc', candidates: [{ id: 'c1', trainNumber: 'KTX 5', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }] }),
      'mock',
    );
    await worker.runJobOnce(pcJob.id, pcJob.userId, 'p1'); // DRAFT -> SCHEDULED
    await worker.runJobOnce(pcJob.id, pcJob.userId, 'p2'); // SCHEDULED -> WATCHING
    const held = await worker.runJobOnce(pcJob.id, pcJob.userId, 'p3'); // -> HELD
    assert.equal(held.status, 'HELD');

    await withEnv({ RAIL_RESERVATION_PROVIDER: 'official' }, async () => {
      const changed = await worker.runJobOnce(pcJob.id, pcJob.userId, 'p4');
      assert.equal(changed.status, 'PROVIDER_CHANGED', 'a Provider flip must be representable from HELD, not just WATCHING/RESERVING');
      assert.ok(changed.holdExpiresAt, 'PROVIDER_CHANGED must not clear a previously recorded holdExpiresAt');
      const again = await worker.runJobOnce(pcJob.id, pcJob.userId, 'p5');
      assert.equal(again.status, 'PROVIDER_CHANGED');
      assert.equal(again.history.length, changed.history.length, 'a repeat tick after PROVIDER_CHANGED must not throw and must not add history');
    });
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

  // -- simulation guard: JSON number 1-5 allowed, everything else rejected --
  // including numeric *strings*, which Number(intervalSeconds) coercion used
  // to accept as if they were the number itself.
  await withEnv({ ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, () => {
    for (const seconds of [1, 2, 3, 4, 5]) {
      assert.equal(assertSimulationAllowed({ intervalSeconds: seconds, provider: 'mock' }), seconds);
    }
    for (const bad of [0, 6, 2.5, -1, 'abc', '1', '2', ' 1 ', '01', '5', null, true, [1], { seconds: 1 }]) {
      assert.throws(() => assertSimulationAllowed({ intervalSeconds: bad, provider: 'mock' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, `interval ${JSON.stringify(bad)} must be rejected`);
    }
    assert.throws(() => assertSimulationAllowed({ intervalSeconds: 3, provider: 'official' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, 'non-mock provider must be rejected');
  });
  await withEnv({ ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'production' }, () => {
    assert.throws(() => assertSimulationAllowed({ intervalSeconds: 3, provider: 'mock' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, 'production must always reject a valid numeric value too');
  });
  await withEnv({ ENABLE_MOCK_SIMULATION: 'false', NODE_ENV: 'test' }, () => {
    assert.throws(() => assertSimulationAllowed({ intervalSeconds: 3, provider: 'mock' }), { code: 'SIMULATION_INTERVAL_NOT_ALLOWED' }, 'ENABLE_MOCK_SIMULATION=false must reject even valid values');
  });

  // -- idempotency keys are scoped to (userId, jobId), not the raw key alone --
  queue.__resetQueueForTests();
  assert.equal(queue.enqueue({ jobId: 'job-a', userId: 'demo-u1', idempotencyKey: 'shared' }), 'queued');
  assert.equal(queue.enqueue({ jobId: 'job-a', userId: 'demo-u1', idempotencyKey: 'shared' }), 'duplicate', 'same job + same user + same key must be a duplicate');
  assert.equal(queue.enqueue({ jobId: 'job-b', userId: 'demo-u1', idempotencyKey: 'shared' }), 'queued', 'a different job must not be shadowed by another job\'s raw key');
  assert.equal(queue.enqueue({ jobId: 'job-a', userId: 'demo-u2', idempotencyKey: 'shared' }), 'queued', 'a different user must not be shadowed by another user\'s raw key, even for the same job id string');
  queue.__resetQueueForTests();

  // -- API routes: creation, official-provider block, and the simulate route's
  // required-field guard (no bypass, job untouched on every rejection) --
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true', ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const createReq = new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-api1' }), 'block-api-create'));
    const createRes = await reservationsRoute.POST(createReq);
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    const jobId = created.job.id;
    assert.equal(created.job.simulation, true, 'the API create response must explicitly mark the job simulation:true');

    const dupRes = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-api1' }), 'block-api-create')));
    assert.equal(dupRes.status, 409);

    const badRes = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody({ userId: 'not-demo' }, 'block-api-create')));
    assert.equal(badRes.status, 400);

    const listRes = await reservationsRoute.GET(new NextRequest('http://test/api/reservations?userId=demo-api1'));
    assert.equal(listRes.status, 200);
    assert.equal((await listRes.json()).jobs.length, 1);

    const detailRes = await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${jobId}?userId=demo-api1`), { params: Promise.resolve({ id: jobId }) });
    assert.equal(detailRes.status, 200);

    const wrongUserRes = await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${jobId}?userId=demo-someoneelse`), { params: Promise.resolve({ id: jobId }) });
    assert.equal(wrongUserRes.status, 404);

    // -- simulate: missing field, and every out-of-range value, must be rejected
    // and must leave the job's status/history/attempts completely untouched --
    const snapshotBefore = JSON.stringify((await (await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${jobId}?userId=demo-api1`), { params: Promise.resolve({ id: jobId }) })).json()).job);

    const missingRes = await simulateRoute.POST(
      new NextRequest(`http://test/api/reservations/${jobId}/simulate`, jsonBody({ userId: 'demo-api1', idempotencyKey: 'missing-1' })),
      { params: Promise.resolve({ id: jobId }) },
    );
    assert.equal(missingRes.status, 400, 'omitting simulationIntervalSeconds must be rejected, not silently allowed through');

    // Out-of-range numbers, and every non-number JSON type -- numeric strings
    // ("1", "01", " 1 ") most importantly, since Number(intervalSeconds)
    // coercion used to let those through as if they were the JSON number 1.
    const badIntervals = [
      { label: 'zero', value: 0 },
      { label: 'six', value: 6 },
      { label: 'decimal', value: 2.5 },
      { label: 'negative', value: -1 },
      { label: 'word-string', value: 'abc' },
      { label: 'numeric-string-1', value: '1' },
      { label: 'numeric-string-2', value: '2' },
      { label: 'numeric-string-padded', value: ' 1 ' },
      { label: 'numeric-string-zero-padded', value: '01' },
      { label: 'numeric-string-5', value: '5' },
      { label: 'null', value: null },
      { label: 'boolean', value: true },
      { label: 'array', value: [1] },
      { label: 'object', value: { seconds: 1 } },
    ];
    for (const { label, value } of badIntervals) {
      const res = await simulateRoute.POST(
        new NextRequest(`http://test/api/reservations/${jobId}/simulate`, jsonBody({ userId: 'demo-api1', idempotencyKey: `bad-${label}`, simulationIntervalSeconds: value })),
        { params: Promise.resolve({ id: jobId }) },
      );
      assert.ok(res.status === 400 || res.status === 403, `interval ${label} (${JSON.stringify(value)}) must be rejected at the route (got ${res.status})`);
    }

    const afterBadJson = await (await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${jobId}?userId=demo-api1`), { params: Promise.resolve({ id: jobId }) })).json();
    assert.equal(JSON.stringify(afterBadJson.job), snapshotBefore, 'every rejected simulate call must leave the job byte-for-byte unchanged');

    // -- a valid interval actually advances the job --
    const simRes = await simulateRoute.POST(
      new NextRequest(`http://test/api/reservations/${jobId}/simulate`, jsonBody({ userId: 'demo-api1', idempotencyKey: 'sim-1', simulationIntervalSeconds: 2 })),
      { params: Promise.resolve({ id: jobId }) },
    );
    assert.equal(simRes.status, 200);
    assert.equal((await simRes.json()).job.status, 'SCHEDULED');

    const cancelRes = await cancelRoute.POST(
      new NextRequest(`http://test/api/reservations/${jobId}/cancel`, jsonBody({ userId: 'demo-api1' })),
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
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'false', NODE_ENV: 'test' }, async () => {
    const res = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-api2' }), 'block-jobs-disabled')));
    assert.equal(res.status, 503);
  });
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'disabled', ENABLE_RESERVATION_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    const res = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-api3' }), 'block-provider-disabled')));
    assert.equal(res.status, 503);
  });

  // -- the official Provider Stub must never be reachable via job creation --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'official', ENABLE_RESERVATION_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    const res = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-official' }), 'block-official')));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'OFFICIAL_INTEGRATION_REQUIRED');
  });

  // -- production must fail closed on every Demo route except provider-status,
  // regardless of every other flag, and must never mutate an existing job --
  resetAll();
  await withEnv({ RAIL_RESERVATION_PROVIDER: 'mock', ENABLE_RESERVATION_JOBS: 'true', ENABLE_MOCK_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    const createRes = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-prodcheck' }), 'block-production')));
    const { job: prodJob } = await createRes.json();

    await withEnv({ NODE_ENV: 'production' }, async () => {
      const createBlocked = await reservationsRoute.POST(new NextRequest('http://test/api/reservations', jsonBody(baseInput({ userId: 'demo-prodcheck2' }), 'block-production')));
      assert.equal(createBlocked.status, 503);

      const listBlocked = await reservationsRoute.GET(new NextRequest(`http://test/api/reservations?userId=${prodJob.userId}`));
      assert.equal(listBlocked.status, 503);

      const detailBlocked = await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${prodJob.id}?userId=${prodJob.userId}`), { params: Promise.resolve({ id: prodJob.id }) });
      assert.equal(detailBlocked.status, 503);

      const cancelBlocked = await cancelRoute.POST(
        new NextRequest(`http://test/api/reservations/${prodJob.id}/cancel`, jsonBody({ userId: prodJob.userId })),
        { params: Promise.resolve({ id: prodJob.id }) },
      );
      assert.equal(cancelBlocked.status, 503);

      // Even a syntactically valid interval must not reach the Worker in production.
      const simBlocked = await simulateRoute.POST(
        new NextRequest(`http://test/api/reservations/${prodJob.id}/simulate`, jsonBody({ userId: prodJob.userId, idempotencyKey: 'prod-sim', simulationIntervalSeconds: 3 })),
        { params: Promise.resolve({ id: prodJob.id }) },
      );
      assert.equal(simBlocked.status, 503);
      const simBlockedNoField = await simulateRoute.POST(
        new NextRequest(`http://test/api/reservations/${prodJob.id}/simulate`, jsonBody({ userId: prodJob.userId, idempotencyKey: 'prod-sim-2' })),
        { params: Promise.resolve({ id: prodJob.id }) },
      );
      assert.equal(simBlockedNoField.status, 503);

      // provider-status is explicitly excluded from the production block.
      const statusRes = await providerStatusRoute.GET();
      assert.equal(statusRes.status, 200);
    });

    const afterJson = await (await reservationDetailRoute.GET(new NextRequest(`http://test/api/reservations/${prodJob.id}?userId=${prodJob.userId}`), { params: Promise.resolve({ id: prodJob.id }) })).json();
    assert.equal(JSON.stringify(afterJson.job), JSON.stringify(prodJob), 'every production-blocked call above must have left the job byte-for-byte unchanged');
  });

  console.log = originalLog;
  console.error = originalError;

  assert.equal(fetchCalls, 0, 'the reservation subsystem must never call fetch');
  const leaked = capturedLogs.some((line) => line.includes(FAKE_SECRET));
  assert.equal(leaked, false, 'no reservation log line may contain a secret value');

  originalLog(JSON.stringify({ result: 'PASS', fetchCalls, capturedLogLines: capturedLogs.length }));
}

main().catch((error) => {
  console.error = originalError;
  originalError(error);
  process.exitCode = 1;
});
