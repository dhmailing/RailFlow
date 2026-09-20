// Offline contract checks for the v0.5 auth + Seat Watch subsystem
// (lib/auth/**, lib/watch/**, app/api/auth/**, app/api/devices, app/api/watch-jobs/**).
// No production credentials, no external network calls -- every outcome
// comes from lib/watch/mock-seat-provider.ts and the InMemory notification
// adapter. v0.3's schedule/station/fare suite (scripts/verify-rail.cjs) and
// v0.4's reservation-job suite (scripts/verify-reservation.cjs) are not
// duplicated here and must both still pass on their own.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader isolates TypeScript modules for offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname, '..');
const loadedModules = new Map();

// A minimal in-memory fake for next/headers's cookies() -- route handlers
// invoked directly here (not through Next's real request pipeline) have no
// AsyncLocalStorage request context, so the real cookies() would throw. This
// fake only needs to satisfy lib/auth/session.ts's `(await cookies()).set/
// .delete` calls; it is not used to assert any cookie behavior itself (that
// would need a real browser/Next server, out of scope for this offline
// script -- the JSON response bodies are asserted instead).
function fakeNextHeaders() {
  const jar = new Map();
  return {
    cookies: async () => ({
      set: (name, value) => jar.set(name, value),
      delete: (name) => jar.delete(name),
      get: (name) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    }),
  };
}

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
      : name === 'next/headers'
        ? fakeNextHeaders()
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

// No module under test may ever open a network connection -- most
// importantly, never to korail.com, srail.or.kr, or any TAGO/data.go.kr host.
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`v0.5 subsystem must never call fetch (attempted: ${url})`);
};

const FAKE_PASSWORD = 'S3cret-Pw-fixture-only-999';
const capturedLogs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { capturedLogs.push(args.map(String).join(' ')); };
console.error = (...args) => { capturedLogs.push(args.map(String).join(' ')); };

const { canTransition, hasExpired } = load('lib/watch/state-machine.ts');
const { assertSimulationAllowed } = load('lib/watch/simulation-guard.ts');
const watchStore = load('lib/watch/store.ts');
const watchQueue = load('lib/watch/queue.ts');
const { dispatchNotification } = load('lib/watch/notification/dispatch.ts');
const { listInMemoryDeliveries, __resetInMemoryNotificationsForTests } = load('lib/watch/notification/adapters.ts');

const signupRoute = load('app/api/auth/signup/route.ts');
const loginRoute = load('app/api/auth/login/route.ts');
const logoutRoute = load('app/api/auth/logout/route.ts');
const sessionRoute = load('app/api/auth/session/route.ts');
const accountRoute = load('app/api/auth/account/route.ts');

const devicesRoute = load('app/api/devices/route.ts');
const watchJobsRoute = load('app/api/watch-jobs/route.ts');
const watchJobDetailRoute = load('app/api/watch-jobs/[id]/route.ts');
const watchJobCancelRoute = load('app/api/watch-jobs/[id]/cancel/route.ts');
const watchJobSimulateRoute = load('app/api/watch-jobs/[id]/simulate/route.ts');
const watchJobConfirmRoute = load('app/api/watch-jobs/[id]/confirm-booking/route.ts');
const watchJobResumeRoute = load('app/api/watch-jobs/[id]/resume/route.ts');
const providerStatusRoute = load('app/api/watch-jobs/provider-status/route.ts');

function resetAll() {
  watchStore.__resetWatchStoreForTests();
  watchQueue.__resetQueueForTests();
  __resetInMemoryNotificationsForTests();
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

function req(url, { method = 'GET', body, token, clientId = 'test-client' } = {}) {
  const headers = { 'x-forwarded-for': clientId };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function signup(email, clientId) {
  const res = await signupRoute.POST(req('http://test/api/auth/signup', { method: 'POST', body: { email, password: FAKE_PASSWORD }, clientId }));
  const payload = await res.json();
  return { status: res.status, ...payload };
}

function baseJobInput(overrides = {}) {
  return {
    departure: '동탄',
    arrival: '울산(통도사)',
    departureId: 'demo-0',
    arrivalId: 'demo-1',
    date: '2026-09-26',
    timeRangeStart: '09:00',
    timeRangeEnd: '18:00',
    trainType: 'KTX',
    passengers: 1,
    seatClassPreference: 'standard_preferred',
    candidates: [{ id: 'cand-1', trainNumber: 'KTX 101', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }],
    watchUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    notificationMethods: [],
    ...overrides,
  };
}

async function main() {
  // -- state machine --
  assert.equal(canTransition('REGISTERED', 'WATCHING'), true);
  assert.equal(canTransition('REGISTERED', 'SEAT_FOUND'), false);
  assert.equal(canTransition('WATCHING', 'PROVIDER_UNAVAILABLE'), true);
  assert.equal(canTransition('PROVIDER_UNAVAILABLE', 'WATCHING'), true);
  assert.equal(canTransition('SEAT_FOUND', 'COMPLETED'), true);
  assert.equal(canTransition('SEAT_FOUND', 'WATCHING'), true);
  assert.equal(canTransition('COMPLETED', 'WATCHING'), false, 'terminal states never transition anywhere');
  assert.equal(hasExpired({ watchUntil: new Date(Date.now() - 1000).toISOString() }), true);
  assert.equal(hasExpired({ watchUntil: new Date(Date.now() + 60_000).toISOString() }), false);

  // -- simulation guard: JSON number 1-5 only, exactly like v0.4 PR #7's final fix --
  await withEnv({ ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, () => {
    for (const tick of [1, 2, 3, 4, 5]) {
      assert.equal(assertSimulationAllowed({ tick, seatProvider: 'mock' }), tick);
    }
    for (const bad of [0, 6, 2.5, -1, 'abc', '1', ' 1 ', '01', null, true, [1], { tick: 1 }]) {
      assert.throws(() => assertSimulationAllowed({ tick: bad, seatProvider: 'mock' }), { code: 'SIMULATION_NOT_ALLOWED' }, `tick ${JSON.stringify(bad)} must be rejected`);
    }
    assert.throws(() => assertSimulationAllowed({ tick: 3, seatProvider: 'unavailable' }), { code: 'SIMULATION_NOT_ALLOWED' }, 'non-mock provider must be rejected');
  });
  await withEnv({ ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'production' }, () => {
    assert.throws(() => assertSimulationAllowed({ tick: 3, seatProvider: 'mock' }), { code: 'SIMULATION_NOT_ALLOWED' }, 'production must always reject, even a valid tick');
  });
  await withEnv({ ENABLE_MOCK_SEAT_SIMULATION: 'false', NODE_ENV: 'test' }, () => {
    assert.throws(() => assertSimulationAllowed({ tick: 3, seatProvider: 'mock' }), { code: 'SIMULATION_NOT_ALLOWED' }, 'ENABLE_MOCK_SEAT_SIMULATION=false must reject even valid values');
  });

  await withEnv({ NODE_ENV: 'test' }, async () => {
    // -- auth: signup/login/session/logout, and missing/garbage tokens blocked --
    resetAll();
    const signedUp = await signup('user-a@example.com', 'block-signup-a');
    assert.equal(signedUp.status, 201);
    assert.ok(signedUp.token);
    const tokenA = signedUp.token;

    const dup = await signup('user-a@example.com', 'block-signup-a');
    assert.equal(dup.status, 409);
    assert.equal(dup.error.code, 'EMAIL_TAKEN');

    const badLogin = await loginRoute.POST(req('http://test/api/auth/login', { method: 'POST', body: { email: 'user-a@example.com', password: 'wrong-password' }, clientId: 'block-login-a' }));
    assert.equal(badLogin.status, 401);
    assert.equal((await badLogin.json()).error.code, 'INVALID_CREDENTIALS');

    const goodLogin = await loginRoute.POST(req('http://test/api/auth/login', { method: 'POST', body: { email: 'user-a@example.com', password: FAKE_PASSWORD }, clientId: 'block-login-a' }));
    assert.equal(goodLogin.status, 200);

    const sessionOk = await sessionRoute.GET(req('http://test/api/auth/session', { token: tokenA }));
    assert.equal(sessionOk.status, 200);
    assert.equal((await sessionOk.json()).user.email, 'user-a@example.com');

    const sessionMissing = await sessionRoute.GET(req('http://test/api/auth/session'));
    assert.equal(sessionMissing.status, 401);
    assert.equal((await sessionMissing.json()).error.code, 'UNAUTHENTICATED');

    const sessionGarbage = await sessionRoute.GET(req('http://test/api/auth/session', { token: 'not-a-real-token' }));
    assert.equal(sessionGarbage.status, 401);
    assert.equal((await sessionGarbage.json()).error.code, 'SESSION_EXPIRED');

    await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', token: tokenA }));
    const afterLogout = await sessionRoute.GET(req('http://test/api/auth/session', { token: tokenA }));
    assert.equal(afterLogout.status, 401, 'logout must actually revoke the session, not just clear the cookie client-side');
  });

  // -- authentication is required on every watch-job/device route --
  resetAll();
  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    const noAuthCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput(), clientId: 'block-noauth' }));
    assert.equal(noAuthCreate.status, 401);
    const noAuthList = await watchJobsRoute.GET(req('http://test/api/watch-jobs'));
    assert.equal(noAuthList.status, 401);
    const noAuthDevices = await devicesRoute.GET(req('http://test/api/devices'));
    assert.equal(noAuthDevices.status, 401);
    const noAuthDetail = await watchJobDetailRoute.GET(req('http://test/api/watch-jobs/nonexistent'), { params: Promise.resolve({ id: 'nonexistent' }) });
    assert.equal(noAuthDetail.status, 401);
  });

  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    // -- user isolation + wrong/nonexistent job id access --
    resetAll();
    const userA = await signup('isolate-a@example.com', 'block-isolate');
    const userB = await signup('isolate-b@example.com', 'block-isolate');

    const deviceA = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'a@example.com' }, token: userA.token, clientId: 'block-device' }));
    const deviceAJson = await deviceA.json();

    const createA = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: deviceAJson.device.id }] }), token: userA.token, clientId: 'block-create-a' }));
    assert.equal(createA.status, 201);
    const jobA = (await createA.json()).job;

    const listB = await watchJobsRoute.GET(req('http://test/api/watch-jobs', { token: userB.token }));
    assert.equal((await listB.json()).jobs.length, 0, "user B's job list must not include user A's job");

    const detailByB = await watchJobDetailRoute.GET(req(`http://test/api/watch-jobs/${jobA.id}`, { token: userB.token }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(detailByB.status, 404, "another user's real job id must read exactly like a nonexistent one");

    const randomId = await watchJobDetailRoute.GET(req('http://test/api/watch-jobs/does-not-exist', { token: userA.token }), { params: Promise.resolve({ id: 'does-not-exist' }) });
    assert.equal(randomId.status, 404);

    const cancelByB = await watchJobCancelRoute.POST(req(`http://test/api/watch-jobs/${jobA.id}/cancel`, { method: 'POST', token: userB.token, clientId: 'block-cancel-b' }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(cancelByB.status, 404, "user B must not be able to cancel user A's job");

    // -- duplicate watch prevention --
    const dupCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: deviceAJson.device.id }] }), token: userA.token, clientId: 'block-create-a' }));
    assert.equal(dupCreate.status, 409);
    assert.equal((await dupCreate.json()).error.code, 'DUPLICATE_JOB');

    // -- cancel + re-cancel rejected --
    const cancelA = await watchJobCancelRoute.POST(req(`http://test/api/watch-jobs/${jobA.id}/cancel`, { method: 'POST', token: userA.token, clientId: 'block-cancel-a' }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(cancelA.status, 200);
    assert.equal((await cancelA.json()).job.status, 'CANCELLED');
    const reCancel = await watchJobCancelRoute.POST(req(`http://test/api/watch-jobs/${jobA.id}/cancel`, { method: 'POST', token: userA.token, clientId: 'block-cancel-a' }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(reCancel.status, 409);

    // Cancelling frees the dedupe key for a fresh job with the same route/date/passengers.
    const afterCancelCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: deviceAJson.device.id }] }), token: userA.token, clientId: 'block-create-a2' }));
    assert.equal(afterCancelCreate.status, 201);
  });

  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    // -- full state transition + Mock seat-found + notification flow, via the
    // real API routes (not the internal store) --
    resetAll();
    const user = await signup('flow@example.com', 'block-flow');
    const deviceRes = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'flow@example.com' }, token: user.token, clientId: 'block-flow-device' }));
    const device = (await deviceRes.json()).device;

    const createRes = await watchJobsRoute.POST(
      req('http://test/api/watch-jobs', {
        method: 'POST',
        body: baseJobInput({
          candidates: [
            { id: 'never', trainNumber: 'KTX 900', trainType: 'KTX', departAt: '2026-09-26T08:00:00+09:00', arriveAt: '2026-09-26T10:00:00+09:00', mockScenario: 'no_seat_ever' },
            { id: 'appears', trainNumber: 'KTX 901', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'seat_after_one_check' },
          ],
          notificationMethods: [{ channel: 'email', deviceId: device.id }],
        }),
        token: user.token,
        clientId: 'block-flow-create',
      }),
    );
    assert.equal(createRes.status, 201);
    const job = (await createRes.json()).job;
    assert.equal(job.status, 'REGISTERED');
    assert.equal(job.simulation, true);

    const tick = async (n) => {
      const res = await watchJobSimulateRoute.POST(
        req(`http://test/api/watch-jobs/${job.id}/simulate`, { method: 'POST', body: { idempotencyKey: crypto.randomUUID(), tick: n }, token: user.token, clientId: 'block-flow-sim' }),
        { params: Promise.resolve({ id: job.id }) },
      );
      assert.equal(res.status, 200, `tick must succeed: ${JSON.stringify(await res.clone().json())}`);
      return (await res.json()).job;
    };

    let state = await tick(1); // REGISTERED -> WATCHING
    assert.equal(state.status, 'WATCHING');
    state = await tick(2); // checks "never" -> not available
    assert.equal(state.status, 'WATCHING');
    assert.equal(state.attempts, 1);
    state = await tick(3); // checks "appears", attempts>=1 -> available -> SEAT_FOUND
    assert.equal(state.status, 'SEAT_FOUND');
    assert.equal(state.foundCandidateId, 'appears', "once a candidate is found, the job stops watching the others");

    const deliveries = watchStore.listNotificationDeliveries(user.user.id, job.id);
    assert.equal(deliveries.filter((d) => d.eventType === 'seat_found' && d.status === 'delivered').length, 1, 'exactly one seat_found notification must be delivered');
    assert.equal(listInMemoryDeliveries().length, 1, 'the InMemory adapter must have been called exactly once');

    // -- "다시 감시" then re-drive to SEAT_FOUND and "예매 완료" --
    const resumed = await watchJobResumeRoute.POST(req(`http://test/api/watch-jobs/${job.id}/resume`, { method: 'POST', token: user.token, clientId: 'block-flow-resume' }), { params: Promise.resolve({ id: job.id }) });
    assert.equal((await resumed.json()).job.status, 'WATCHING');

    state = await tick(4); // "never" again -> WATCHING
    state = await tick(5); // "appears" again -> SEAT_FOUND (a *second* logical seat_found event)
    assert.equal(state.status, 'SEAT_FOUND');

    const confirmRes = await watchJobConfirmRoute.POST(req(`http://test/api/watch-jobs/${job.id}/confirm-booking`, { method: 'POST', token: user.token, clientId: 'block-flow-confirm' }), { params: Promise.resolve({ id: job.id }) });
    assert.equal(confirmRes.status, 200);
    assert.equal((await confirmRes.json()).job.status, 'COMPLETED');

    const reConfirm = await watchJobConfirmRoute.POST(req(`http://test/api/watch-jobs/${job.id}/confirm-booking`, { method: 'POST', token: user.token, clientId: 'block-flow-confirm' }), { params: Promise.resolve({ id: job.id }) });
    assert.equal(reConfirm.status, 409, 'confirming an already-COMPLETED job must be rejected, not silently repeat');
  });

  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    // -- error scenario: error_on_check surfaces a structured error, watching continues --
    resetAll();
    const user = await signup('err@example.com', 'block-err');
    const jobId = watchStore.createWatchJob(
      { ...baseJobInput(), userId: user.user.id, candidates: [{ id: 'x', trainNumber: 'KTX 2', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'error_on_check' }] },
      'mock',
    ).id;
    const worker = load('lib/watch/worker.ts');
    await worker.runJobOnce(jobId, user.user.id, 'e1');
    await worker.runJobOnce(jobId, user.user.id, 'e2');
    const afterError = await worker.runJobOnce(jobId, user.user.id, 'e3');
    assert.equal(afterError.status, 'WATCHING');
    assert.equal(afterError.lastError.code, 'CHECK_FAILED');
  });

  // -- expiry is persisted (not thrown), and a replay is a total no-op --
  resetAll();
  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    const user = await signup('expire@example.com', 'block-expire');
    const worker = load('lib/watch/worker.ts');
    const job = watchStore.createWatchJob({ ...baseJobInput(), userId: user.user.id, watchUntil: new Date(Date.now() + 150).toISOString() }, 'mock');
    const scheduled = await worker.runJobOnce(job.id, user.user.id, 'x1');
    assert.equal(scheduled.status, 'WATCHING');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const expired = await worker.runJobOnce(job.id, user.user.id, 'x2');
    assert.equal(expired.status, 'EXPIRED');
    const rerun = await worker.runJobOnce(job.id, user.user.id, 'x3');
    assert.equal(JSON.stringify(rerun), JSON.stringify(expired), 'replaying an EXPIRED job must be a total no-op');
    const expiredNotice = watchStore.listNotificationDeliveries(user.user.id, job.id).filter((d) => d.eventType === 'watch_expired');
    assert.equal(expiredNotice.length, 0, 'no notification methods were registered for this job, so none should have been attempted');
  });

  // -- PROVIDER_UNAVAILABLE is a real, honest state, and resumes once a provider connects --
  resetAll();
  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'disabled', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    const user = await signup('unavail@example.com', 'block-unavail');
    const worker = load('lib/watch/worker.ts');
    const job = watchStore.createWatchJob({ ...baseJobInput(), userId: user.user.id }, 'unavailable');
    assert.equal(job.simulation, false);
    await worker.runJobOnce(job.id, user.user.id, 'u1'); // REGISTERED -> WATCHING
    const unavailable = await worker.runJobOnce(job.id, user.user.id, 'u2');
    assert.equal(unavailable.status, 'PROVIDER_UNAVAILABLE');
    const stillUnavailable = await worker.runJobOnce(job.id, user.user.id, 'u3');
    assert.equal(stillUnavailable.status, 'PROVIDER_UNAVAILABLE');
    assert.equal(stillUnavailable.updatedAt, unavailable.updatedAt, 'a stable PROVIDER_UNAVAILABLE tick must be a no-op, not spam history');

    await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock' }, async () => {
      const resumed = await worker.runJobOnce(job.id, user.user.id, 'u4');
      assert.equal(resumed.status, 'WATCHING', 'once a Provider connects, PROVIDER_UNAVAILABLE must resume watching automatically');
    });
  });

  // -- notification retry-on-failure + idempotency-on-success --
  resetAll();
  await withEnv({ NODE_ENV: 'test' }, async () => {
    const user = await signup('notif@example.com', 'block-notif');
    const jobId = watchStore.createWatchJob({ ...baseJobInput(), userId: user.user.id }, 'mock').id;
    const key = 'retry-idem-test';

    await withEnv({ NODE_ENV: 'production' }, async () => {
      const failed = await dispatchNotification({
        userId: user.user.id, watchJobId: jobId, candidateId: null, channel: 'email', eventType: 'seat_found',
        idempotencyKey: key, destination: 'notif@example.com', title: 't', body: 'b',
      });
      assert.equal(failed.status, 'failed', 'no real channel is configured in production, so the first attempt must fail closed');
    });

    assert.equal(watchStore.hasDeliveredNotification(user.user.id, key), false, 'a failed attempt must not be treated as delivered');

    const delivered = await dispatchNotification({
      userId: user.user.id, watchJobId: jobId, candidateId: null, channel: 'email', eventType: 'seat_found',
      idempotencyKey: key, destination: 'notif@example.com', title: 't', body: 'b',
    });
    assert.equal(delivered.status, 'delivered', 'the same idempotencyKey must be retryable after a failure, and now succeeds (dev/test uses the InMemory adapter)');

    const dupe = await dispatchNotification({
      userId: user.user.id, watchJobId: jobId, candidateId: null, channel: 'email', eventType: 'seat_found',
      idempotencyKey: key, destination: 'notif@example.com', title: 't', body: 'b',
    });
    assert.equal(dupe.status, 'skipped_duplicate', 'a second delivery attempt with the same key after success must not resend');
    assert.equal(listInMemoryDeliveries().length, 1, 'the adapter itself must only ever have been invoked once for this key');
  });

  // -- Production: Mock simulation is always blocked; ordinary job CRUD is not
  // (a user may legitimately register a watch before any Provider exists) --
  resetAll();
  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    const user = await signup('prod@example.com', 'block-prod');
    const deviceRes = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'prod@example.com' }, token: user.token, clientId: 'block-prod-device' }));
    const device = (await deviceRes.json()).device;
    const createRes = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: device.id }] }), token: user.token, clientId: 'block-prod-create' }));
    const job = (await createRes.json()).job;

    await withEnv({ NODE_ENV: 'production' }, async () => {
      const simBlocked = await watchJobSimulateRoute.POST(
        req(`http://test/api/watch-jobs/${job.id}/simulate`, { method: 'POST', body: { idempotencyKey: 'prod-1', tick: 3 }, token: user.token, clientId: 'block-prod-sim' }),
        { params: Promise.resolve({ id: job.id }) },
      );
      assert.equal(simBlocked.status, 503, 'Mock simulation must always be blocked in production, even with a syntactically valid tick');

      // Ordinary CRUD (create/list/detail) is allowed once authenticated --
      // PROVIDER_UNAVAILABLE is the honest state a Production user sees.
      const listRes = await watchJobsRoute.GET(req('http://test/api/watch-jobs', { token: user.token }));
      assert.equal(listRes.status, 200);
      const statusRes = await providerStatusRoute.GET();
      assert.equal(statusRes.status, 200);
      assert.equal((await statusRes.json()).mockSimulationEnabled, false, 'provider-status must report simulation as unavailable in production regardless of the env flag');
    });

    const afterProd = await watchJobDetailRoute.GET(req(`http://test/api/watch-jobs/${job.id}`, { token: user.token }), { params: Promise.resolve({ id: job.id }) });
    assert.equal((await afterProd.json()).job.status, job.status, 'the production-blocked simulate call must not have mutated the job');
  });

  // -- account deletion cascades to watch data --
  resetAll();
  await withEnv({ SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    const user = await signup('delete-me@example.com', 'block-delete');
    const deviceRes = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'delete-me@example.com' }, token: user.token, clientId: 'block-delete-device' }));
    const device = (await deviceRes.json()).device;
    const createRes = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: device.id }] }), token: user.token, clientId: 'block-delete-create' }));
    assert.equal(createRes.status, 201);
    assert.equal(watchStore.listWatchJobs(user.user.id).length, 1);

    const deleteRes = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', token: user.token }));
    assert.equal(deleteRes.status, 200);
    assert.equal(watchStore.listWatchJobs(user.user.id).length, 0, 'account deletion must remove the user\'s watch jobs');

    const afterDelete = await sessionRoute.GET(req('http://test/api/auth/session', { token: user.token }));
    assert.equal(afterDelete.status, 401, 'the deleted account\'s session must no longer be valid');
  });

  console.log = originalLog;
  console.error = originalError;

  assert.equal(fetchCalls, 0, 'the v0.5 auth/watch subsystem must never call fetch');
  const leaked = capturedLogs.some((line) => line.includes(FAKE_PASSWORD));
  assert.equal(leaked, false, 'no log line may contain a plaintext password');

  originalLog(JSON.stringify({ result: 'PASS', fetchCalls, capturedLogLines: capturedLogs.length }));
}

main().catch((error) => {
  console.error = originalError;
  originalError(error);
  process.exitCode = 1;
});
