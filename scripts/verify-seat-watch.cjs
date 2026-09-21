// Offline contract checks for the v0.5 auth + Seat Watch subsystem
// (lib/auth/**, lib/watch/**, lib/security/**, app/api/auth/**, app/api/devices,
// app/api/watch-jobs/**), including the security/correctness review round
// (AUTH_STORE/WATCH_STORE fail-closed flags, cookie-only sessions with no
// token in JSON, Origin/CSRF guard, account-deletion reauth, masked device
// DTOs, channel-match validation, multi-channel/multi-device/re-watch
// notification idempotency, and candidate id/externalKey validation). No
// production credentials, no external network calls -- every outcome comes
// from lib/watch/mock-seat-provider.ts and the InMemory notification
// adapter. v0.3's schedule/station/fare suite (scripts/verify-rail.cjs) and
// v0.4's reservation-job suite (scripts/verify-reservation.cjs) are not
// duplicated here and must both still pass on their own.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader isolates TypeScript modules for offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');
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

// AUTH_STORE/WATCH_STORE default to "disabled" (fail-closed) -- most
// scenarios below need both set to "memory" to exercise the actual auth/
// watch logic at all. NODE_ENV must also not be "production" for either to
// be usable (see lib/auth/feature-flags.ts, lib/watch/feature-flags.ts).
const DEV_STORES = { AUTH_STORE: 'memory', WATCH_STORE: 'memory' };

const authSession = load('lib/auth/session.ts');
const authMemoryStore = load('lib/auth/memory-store.ts');
const auditMemoryStore = load('lib/audit/memory-store.ts');
const { assertTrustedOrigin } = load('lib/security/origin-guard.ts');
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
const authStatusRoute = load('app/api/auth/status/route.ts');
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
  authMemoryStore.__resetAuthStoreForTests();
  auditMemoryStore.__resetAuditStoreForTests();
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

// -- Cookie helpers ----------------------------------------------------------
// lib/auth/session.ts no longer uses next/headers's cookies() (it writes
// directly onto a NextResponse), so route handlers can be invoked exactly
// like a real request/response cycle here -- no fake AsyncLocalStorage
// context is needed any more. Session tokens are asserted from the real
// Set-Cookie header, never read out of a JSON body (the JSON body must not
// contain one at all -- see the assertions below).
function extractSetCookieLines(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function extractCookieValue(response, name) {
  for (const line of extractSetCookieLines(response)) {
    const firstPair = line.split(';')[0];
    const eq = firstPair.indexOf('=');
    if (eq === -1) continue;
    if (firstPair.slice(0, eq) === name) return firstPair.slice(eq + 1);
  }
  return null;
}

function req(url, { method = 'GET', body, cookie, clientId = 'test-client', origin, host } = {}) {
  const parsedUrl = new URL(url);
  const headers = { 'x-forwarded-for': clientId, host: host ?? parsedUrl.host };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `${authSession.getSessionCookieName()}=${cookie}`;
  if (origin !== undefined) headers.origin = origin;
  return new NextRequest(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function signup(email, clientId) {
  const res = await signupRoute.POST(req('http://test/api/auth/signup', { method: 'POST', body: { email, password: FAKE_PASSWORD }, clientId }));
  const payload = await res.json();
  const cookie = extractCookieValue(res, authSession.getSessionCookieName());
  return { status: res.status, cookie, raw: payload, ...payload };
}

async function login(email, password, clientId) {
  const res = await loginRoute.POST(req('http://test/api/auth/login', { method: 'POST', body: { email, password }, clientId }));
  const payload = await res.json();
  const cookie = extractCookieValue(res, authSession.getSessionCookieName());
  return { status: res.status, cookie, raw: payload, ...payload };
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
    candidates: [{ externalKey: 'cand-1', trainNumber: 'KTX 101', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }],
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

  // === §1 검토사항: AUTH_STORE/WATCH_STORE fail-closed =========================

  // Default (no AUTH_STORE set at all) must already block, even outside production.
  await withEnv({ NODE_ENV: 'test' }, async () => {
    resetAll();
    const blockedByDefault = await signup('default-disabled@example.com', 'block-default-disabled');
    assert.equal(blockedByDefault.status, 503);
    assert.equal(blockedByDefault.raw.error.code, 'AUTH_STORE_DISABLED');
    const statusRes = await authStatusRoute.GET();
    assert.equal((await statusRes.json()).enabled, false);
  });

  // AUTH_STORE=memory usable outside production, but WATCH_STORE independently still disabled by default.
  await withEnv({ NODE_ENV: 'test', AUTH_STORE: 'memory' }, async () => {
    resetAll();
    const user = await signup('watchdisabled@example.com', 'block-watchdisabled');
    assert.equal(user.status, 201);
    const statusRes = await authStatusRoute.GET();
    assert.equal((await statusRes.json()).enabled, true);
    const blockedDevice = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'x@example.com' }, cookie: user.cookie, clientId: 'block-watchdisabled-device' }));
    assert.equal(blockedDevice.status, 503);
    assert.equal((await blockedDevice.json()).error.code, 'WATCH_STORE_DISABLED');
  });

  // Production: AUTH_STORE=memory must still be blocked (Vercel Serverless memory cannot be a real account store).
  await withEnv({ NODE_ENV: 'production' }, async () => {
    resetAll();
    const blockedNoFlag = await signup('prod-auth-1@example.com', 'block-prod-auth-1');
    assert.equal(blockedNoFlag.status, 503);
    assert.equal(blockedNoFlag.raw.error.code, 'AUTH_STORE_DISABLED');
  });
  await withEnv({ NODE_ENV: 'production', AUTH_STORE: 'memory' }, async () => {
    resetAll();
    const blockedEvenWithMemory = await signup('prod-auth-2@example.com', 'block-prod-auth-2');
    assert.equal(blockedEvenWithMemory.status, 503, 'AUTH_STORE=memory must still be blocked in production');
    assert.equal(blockedEvenWithMemory.raw.error.code, 'AUTH_STORE_DISABLED');
  });

  // Production: WATCH_STORE=memory must still block job creation/device registration.
  await withEnv({ NODE_ENV: 'production', SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', WATCH_STORE: 'memory' }, async () => {
    resetAll();
    const blockedCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'fcm', deviceId: 'irrelevant' }] }), clientId: 'block-prod-watch-create' }));
    assert.equal(blockedCreate.status, 503);
    assert.equal((await blockedCreate.json()).error.code, 'JOBS_DISABLED');

    const blockedDevice = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'x@example.com' }, clientId: 'block-prod-watch-device' }));
    assert.equal(blockedDevice.status, 503);
    assert.equal((await blockedDevice.json()).error.code, 'WATCH_STORE_DISABLED');
  });

  // === §2 검토사항: 세션 토큰이 JSON에 노출되지 않음 + §9 세션 고정 방지 ==========

  await withEnv({ ...DEV_STORES, NODE_ENV: 'test' }, async () => {
    resetAll();
    const signedUp = await signup('user-a@example.com', 'block-signup-a');
    assert.equal(signedUp.status, 201);
    assert.equal('token' in signedUp.raw, false, 'signup JSON must never contain the session token');
    assert.ok(signedUp.cookie, 'the session token must still be delivered via Set-Cookie');
    const tokenA = signedUp.cookie;

    const dup = await signup('user-a@example.com', 'block-signup-a');
    assert.equal(dup.status, 409);
    assert.equal(dup.raw.error.code, 'EMAIL_TAKEN');

    const badLogin = await login('user-a@example.com', 'wrong-password', 'block-login-a');
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.raw.error.code, 'INVALID_CREDENTIALS');

    const goodLogin = await login('user-a@example.com', FAKE_PASSWORD, 'block-login-a');
    assert.equal(goodLogin.status, 200);
    assert.equal('token' in goodLogin.raw, false, 'login JSON must never contain the session token');
    assert.notEqual(goodLogin.cookie, tokenA, '로그인 성공 시 항상 새 세션을 발급해야 한다(세션 고정 방지)');

    const sessionOk = await sessionRoute.GET(req('http://test/api/auth/session', { cookie: goodLogin.cookie }));
    assert.equal(sessionOk.status, 200);
    assert.equal((await sessionOk.json()).user.email, 'user-a@example.com');
    assert.equal(sessionOk.headers.get('cache-control'), 'no-store');

    const sessionMissing = await sessionRoute.GET(req('http://test/api/auth/session'));
    assert.equal(sessionMissing.status, 401);
    assert.equal((await sessionMissing.json()).error.code, 'UNAUTHENTICATED');

    const sessionGarbage = await sessionRoute.GET(req('http://test/api/auth/session', { cookie: 'not-a-real-token' }));
    assert.equal(sessionGarbage.status, 401);
    assert.equal((await sessionGarbage.json()).error.code, 'SESSION_EXPIRED');

    await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', cookie: goodLogin.cookie }));
    const afterLogout = await sessionRoute.GET(req('http://test/api/auth/session', { cookie: goodLogin.cookie }));
    assert.equal(afterLogout.status, 401, 'logout must actually revoke the session, not just clear the cookie client-side');
  });

  // Cookie attributes: httpOnly/SameSite=Lax/Path=/, and only Production gets Secure + the __Host- name prefix.
  await withEnv({ NODE_ENV: 'test' }, () => {
    const res = NextResponse.json({});
    authSession.setSessionCookie(res, 'fixture-token-dev', new Date(Date.now() + 60_000).toISOString());
    const setCookie = extractSetCookieLines(res)[0];
    assert.ok(setCookie.startsWith('railflow_session=fixture-token-dev'));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    assert.doesNotMatch(setCookie, /Secure/i, '개발 환경(http)에서는 Secure를 강제하면 안 된다');
  });
  await withEnv({ NODE_ENV: 'production' }, () => {
    const res = NextResponse.json({});
    authSession.setSessionCookie(res, 'fixture-token-prod', new Date(Date.now() + 60_000).toISOString());
    const setCookie = extractSetCookieLines(res)[0];
    assert.ok(setCookie.startsWith('__Host-railflow_session=fixture-token-prod'), 'production은 __Host- 접두사를 써야 한다');
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
  });

  // === §3 재검토: APP_ORIGIN 기반 전체 Origin 검증 + 계정삭제 재인증 ===========

  // 올바른 Origin: APP_ORIGIN과 scheme+host가 정확히 일치.
  await withEnv({ NODE_ENV: 'production', APP_ORIGIN: 'http://test' }, () => {
    assert.doesNotThrow(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'http://test' })), 'APP_ORIGIN과 정확히 일치하는 Origin은 허용');
    // 잘못된 host.
    assert.throws(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'http://evil.example' })), { code: 'FORBIDDEN_ORIGIN' }, '다른 host는 거부');
    // 잘못된 scheme(host는 같지만 http vs https) -- Host 헤더 비교였다면 놓쳤을 케이스.
    assert.throws(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'https://test' })), { code: 'FORBIDDEN_ORIGIN' }, 'host가 같아도 scheme이 다르면 거부');
    // Origin 누락.
    assert.throws(() => assertTrustedOrigin(req('http://test/api/x')), { code: 'FORBIDDEN_ORIGIN' }, 'Origin 누락은 허용이 아니라 거부');
  });

  // APP_ORIGIN이 없거나 형식이 잘못된 경우: Host 헤더로 대신 비교하는 폴백 없이 fail-closed.
  await withEnv({ NODE_ENV: 'production' }, () => {
    assert.throws(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'http://test' })), { code: 'FORBIDDEN_ORIGIN' }, 'APP_ORIGIN이 없으면 겉보기에 올바른 Origin도 거부해야 한다');
  });
  await withEnv({ NODE_ENV: 'production', APP_ORIGIN: 'not-a-valid-origin' }, () => {
    assert.throws(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'http://test' })), { code: 'FORBIDDEN_ORIGIN' }, 'APP_ORIGIN이 URL 형식이 아니면 거부해야 한다');
  });
  await withEnv({ NODE_ENV: 'production', APP_ORIGIN: 'http://test/some/path' }, () => {
    assert.throws(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'http://test' })), { code: 'FORBIDDEN_ORIGIN' }, 'APP_ORIGIN에 경로가 포함되면(순수 origin이 아니면) 거부해야 한다');
  });

  await withEnv({ NODE_ENV: 'test' }, () => {
    assert.doesNotThrow(() => assertTrustedOrigin(req('http://test/api/x', { origin: 'http://evil.example' })), '개발/테스트 환경에서는 Origin을 강제하지 않는다(APP_ORIGIN 미설정이어도 통과)');
  });

  // Full-route integration: /api/auth/logout has no store-disabled short-circuit
  // ahead of the Origin check, so it is reachable end-to-end even in production.
  await withEnv({ NODE_ENV: 'production', APP_ORIGIN: 'http://test' }, async () => {
    const forged = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', origin: 'http://evil.example', clientId: 'block-csrf-bad' }));
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).error.code, 'FORBIDDEN_ORIGIN');

    const wrongScheme = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', origin: 'https://test', clientId: 'block-csrf-scheme' }));
    assert.equal(wrongScheme.status, 403, 'scheme만 다른 Origin도 실제 라우트에서 거부돼야 한다');

    const trusted = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', origin: 'http://test', clientId: 'block-csrf-ok' }));
    assert.equal(trusted.status, 200, '일치하는 Origin은 production에서도 통과해야 한다');
  });

  // APP_ORIGIN이 없으면, 실제 라우트에서도 유효해 보이는 Origin까지 통째로 거부된다.
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const noAppOrigin = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', origin: 'http://test', clientId: 'block-csrf-no-app-origin' }));
    assert.equal(noAppOrigin.status, 403, 'APP_ORIGIN 미설정 상태에서는 production의 모든 상태 변경 요청이 거부돼야 한다');
    assert.equal((await noAppOrigin.json()).error.code, 'FORBIDDEN_ORIGIN');
  });

  await withEnv({ ...DEV_STORES, NODE_ENV: 'test' }, async () => {
    resetAll();
    const user = await signup('reauth@example.com', 'block-reauth');
    assert.equal(user.status, 201);

    const noPassword = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', cookie: user.cookie, clientId: 'block-reauth-np' }));
    assert.equal(noPassword.status, 400);

    const wrongPassword = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', body: { password: 'wrong-one' }, cookie: user.cookie, clientId: 'block-reauth-wp' }));
    assert.equal(wrongPassword.status, 401);
    assert.equal((await wrongPassword.json()).error.code, 'REAUTH_REQUIRED');

    const stillLoggedIn = await sessionRoute.GET(req('http://test/api/auth/session', { cookie: user.cookie }));
    assert.equal(stillLoggedIn.status, 200, '재인증 실패는 계정을 삭제해서는 안 된다');

    const rightPassword = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', body: { password: FAKE_PASSWORD }, cookie: user.cookie, clientId: 'block-reauth-ok' }));
    assert.equal(rightPassword.status, 200);
  });

  // -- authentication is required on every watch-job/device route --
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const noAuthCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput(), clientId: 'block-noauth' }));
    assert.equal(noAuthCreate.status, 401);
    const noAuthList = await watchJobsRoute.GET(req('http://test/api/watch-jobs'));
    assert.equal(noAuthList.status, 401);
    const noAuthDevices = await devicesRoute.GET(req('http://test/api/devices'));
    assert.equal(noAuthDevices.status, 401);
    const noAuthDetail = await watchJobDetailRoute.GET(req('http://test/api/watch-jobs/nonexistent'), { params: Promise.resolve({ id: 'nonexistent' }) });
    assert.equal(noAuthDetail.status, 401);
  });

  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    // -- user isolation + wrong/nonexistent job id access --
    resetAll();
    const userA = await signup('isolate-a@example.com', 'block-isolate');
    const userB = await signup('isolate-b@example.com', 'block-isolate');

    const deviceA = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'a@example.com' }, cookie: userA.cookie, clientId: 'block-device' }));
    const deviceAJson = await deviceA.json();
    assert.equal('token' in deviceAJson.device, false, '§5 검토사항: Device API는 원문 token을 절대 반환하지 않는다');
    assert.ok(deviceAJson.device.maskedDestination.includes('•'));
    assert.equal(deviceAJson.device.verified, false, 'email은 소유권 확인 전까지 unverified다');

    const createA = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: deviceAJson.device.id }] }), cookie: userA.cookie, clientId: 'block-create-a' }));
    assert.equal(createA.status, 201);
    const jobA = (await createA.json()).job;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.ok(uuidRe.test(jobA.candidates[0].id), '§7 검토사항: candidate.id는 서버 생성 UUID여야 한다');
    assert.equal(jobA.candidates[0].externalKey, 'cand-1');

    const listB = await watchJobsRoute.GET(req('http://test/api/watch-jobs', { cookie: userB.cookie }));
    assert.equal((await listB.json()).jobs.length, 0, "user B's job list must not include user A's job");

    const detailByB = await watchJobDetailRoute.GET(req(`http://test/api/watch-jobs/${jobA.id}`, { cookie: userB.cookie }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(detailByB.status, 404, "another user's real job id must read exactly like a nonexistent one");

    const randomId = await watchJobDetailRoute.GET(req('http://test/api/watch-jobs/does-not-exist', { cookie: userA.cookie }), { params: Promise.resolve({ id: 'does-not-exist' }) });
    assert.equal(randomId.status, 404);

    const cancelByB = await watchJobCancelRoute.POST(req(`http://test/api/watch-jobs/${jobA.id}/cancel`, { method: 'POST', cookie: userB.cookie, clientId: 'block-cancel-b' }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(cancelByB.status, 404, "user B must not be able to cancel user A's job");

    // -- duplicate watch prevention --
    const dupCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: deviceAJson.device.id }] }), cookie: userA.cookie, clientId: 'block-create-a' }));
    assert.equal(dupCreate.status, 409);
    assert.equal((await dupCreate.json()).error.code, 'DUPLICATE_JOB');

    // -- notification channel/device mismatch rejected (§5) --
    const mismatch = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ departureId: 'demo-2', notificationMethods: [{ channel: 'telegram', deviceId: deviceAJson.device.id }] }), cookie: userA.cookie, clientId: 'block-mismatch' }));
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, 'NOTIFICATION_CHANNEL_MISMATCH');

    // -- cancel + re-cancel rejected --
    const cancelA = await watchJobCancelRoute.POST(req(`http://test/api/watch-jobs/${jobA.id}/cancel`, { method: 'POST', cookie: userA.cookie, clientId: 'block-cancel-a' }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(cancelA.status, 200);
    assert.equal((await cancelA.json()).job.status, 'CANCELLED');
    const reCancel = await watchJobCancelRoute.POST(req(`http://test/api/watch-jobs/${jobA.id}/cancel`, { method: 'POST', cookie: userA.cookie, clientId: 'block-cancel-a' }), { params: Promise.resolve({ id: jobA.id }) });
    assert.equal(reCancel.status, 409);

    // Cancelling frees the dedupe key for a fresh job with the same route/date/passengers.
    const afterCancelCreate = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: deviceAJson.device.id }] }), cookie: userA.cookie, clientId: 'block-create-a2' }));
    assert.equal(afterCancelCreate.status, 201);
  });

  // === §7 검토사항: 후보 열차 검증(중복 externalKey, 날짜/시간범위 불일치, 도착<출발) ===
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const user = await signup('candidate-validate@example.com', 'block-cand');
    const deviceRes = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'fcm', token: 'fcm-token-1' }, cookie: user.cookie, clientId: 'block-cand-device' }));
    const device = (await deviceRes.json()).device;
    assert.equal(device.verified, true, 'fcm은 등록 즉시 verified여야 한다');

    const create = (candidates, clientId) =>
      watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ candidates, notificationMethods: [{ channel: 'fcm', deviceId: device.id }] }), cookie: user.cookie, clientId }));

    const dupExternalKey = await create(
      [
        { externalKey: 'dup', trainNumber: 'KTX 1', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' },
        { externalKey: 'dup', trainNumber: 'KTX 2', trainType: 'KTX', departAt: '2026-09-26T11:00:00+09:00', arriveAt: '2026-09-26T13:00:00+09:00' },
      ],
      'block-cand-dup',
    );
    assert.equal(dupExternalKey.status, 400);
    assert.equal((await dupExternalKey.json()).error.code, 'INVALID_CANDIDATE');

    const wrongDate = await create([{ externalKey: 'wrong-date', trainNumber: 'KTX 3', trainType: 'KTX', departAt: '2026-09-27T10:00:00+09:00', arriveAt: '2026-09-27T12:00:00+09:00' }], 'block-cand-date');
    assert.equal(wrongDate.status, 400);
    assert.equal((await wrongDate.json()).error.code, 'INVALID_CANDIDATE');

    const outsideRange = await create([{ externalKey: 'outside-range', trainNumber: 'KTX 4', trainType: 'KTX', departAt: '2026-09-26T05:00:00+09:00', arriveAt: '2026-09-26T07:00:00+09:00' }], 'block-cand-range');
    assert.equal(outsideRange.status, 400);
    assert.equal((await outsideRange.json()).error.code, 'INVALID_CANDIDATE');

    const backwardsTime = await create([{ externalKey: 'backwards', trainNumber: 'KTX 5', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T09:00:00+09:00' }], 'block-cand-backwards');
    assert.equal(backwardsTime.status, 400);
    assert.equal((await backwardsTime.json()).error.code, 'INVALID_CANDIDATE');

    // A valid set still succeeds, and a client-supplied "id" is ignored -- the
    // server always generates its own UUID.
    const validCreate = await create([{ id: 'client-supplied-fake-id', externalKey: 'valid-1', trainNumber: 'KTX 6', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00' }], 'block-cand-valid');
    assert.equal(validCreate.status, 201);
    const validJob = (await validCreate.json()).job;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.ok(uuidRe.test(validJob.candidates[0].id));
    assert.notEqual(validJob.candidates[0].id, 'client-supplied-fake-id', 'candidate.id must never be client-controlled');
    assert.equal(validJob.candidates[0].externalKey, 'valid-1');
  });

  // === §6 검토사항: 멱등키(channel+deviceId+watchCycle), 다중 채널/기기, 미확인 수신처 스킵, 재감시 후 새 알림 ===
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const user = await signup('flow@example.com', 'block-flow');

    const fcmDevice = (await (await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'fcm', token: 'fcm-flow-token' }, cookie: user.cookie, clientId: 'block-flow-device-fcm' }))).json()).device;
    const webpushDevice = (await (await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'webpush', token: 'webpush-flow-token' }, cookie: user.cookie, clientId: 'block-flow-device-webpush' }))).json()).device;
    const emailDevice = (await (await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'flow@example.com' }, cookie: user.cookie, clientId: 'block-flow-device-email' }))).json()).device;
    assert.equal(fcmDevice.verified, true);
    assert.equal(webpushDevice.verified, true);
    assert.equal(emailDevice.verified, false, '이메일은 소유권 확인 전까지 unverified');

    const createRes = await watchJobsRoute.POST(
      req('http://test/api/watch-jobs', {
        method: 'POST',
        body: baseJobInput({
          timeRangeStart: '07:00',
          candidates: [
            { externalKey: 'never', trainNumber: 'KTX 900', trainType: 'KTX', departAt: '2026-09-26T08:00:00+09:00', arriveAt: '2026-09-26T10:00:00+09:00', mockScenario: 'no_seat_ever' },
            { externalKey: 'appears', trainNumber: 'KTX 901', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'seat_after_one_check' },
          ],
          notificationMethods: [
            { channel: 'fcm', deviceId: fcmDevice.id },
            { channel: 'webpush', deviceId: webpushDevice.id },
            { channel: 'email', deviceId: emailDevice.id },
          ],
        }),
        cookie: user.cookie,
        clientId: 'block-flow-create',
      }),
    );
    assert.equal(createRes.status, 201);
    const job = (await createRes.json()).job;
    assert.equal(job.status, 'REGISTERED');
    assert.equal(job.simulation, true);
    assert.equal(job.watchCycle, 0);

    const tick = async (n) => {
      const res = await watchJobSimulateRoute.POST(
        req(`http://test/api/watch-jobs/${job.id}/simulate`, { method: 'POST', body: { idempotencyKey: crypto.randomUUID(), tick: n }, cookie: user.cookie, clientId: 'block-flow-sim' }),
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
    const foundCandidateExternalKey = state.candidates.find((c) => c.id === state.foundCandidateId)?.externalKey;
    assert.equal(foundCandidateExternalKey, 'appears', 'once a candidate is found, the job stops watching the others');

    let deliveries = watchStore.listNotificationDeliveries(user.user.id, job.id);
    const cycle0SeatFound = deliveries.filter((d) => d.eventType === 'seat_found' && d.watchCycle === 0);
    assert.equal(cycle0SeatFound.filter((d) => d.status === 'delivered').length, 2, '§6: fcm/webpush 각 기기가 한 번씩 알림을 받아야 한다');
    assert.equal(new Set(cycle0SeatFound.filter((d) => d.status === 'delivered').map((d) => d.deviceId)).size, 2, '서로 다른 기기여야 한다');
    assert.equal(cycle0SeatFound.filter((d) => d.status === 'skipped_unverified').length, 1, '§5: 미확인 이메일 수신처는 실제 발송하지 않는다');
    assert.equal(listInMemoryDeliveries().length, 2, '어댑터는 verified 기기 수만큼만 실제로 호출돼야 한다');

    // Reprocessing the exact same event for the same device/channel/cycle must not double-send.
    // (재검토, §6) 이미 끝난 outbox 행은 그대로 "delivered" 상태를 유지한다 --
    // "skipped_duplicate"라는 별도 상태로 다시 쓰지 않는다(claim()의 반환값
    // outcome이 "duplicate"일 뿐, 저장된 행 자체는 갱신되지 않는다).
    const fcmMethodKey = `${job.id}:${state.foundCandidateId}:seat_found:fcm:${fcmDevice.id}:0`;
    const replay = await dispatchNotification({
      userId: user.user.id, watchJobId: job.id, candidateId: state.foundCandidateId, channel: 'fcm', deviceId: fcmDevice.id, watchCycle: 0,
      eventType: 'seat_found', idempotencyKey: fcmMethodKey, destination: fcmDevice.token, deviceVerified: true, title: 't', body: 'b',
    });
    assert.equal(replay.status, 'delivered', '§6: 같은 채널·같은 기기·같은 세대의 완전한 중복은 이미 끝난 delivered 행을 그대로 반환해야 한다');
    assert.equal(listInMemoryDeliveries().length, 2, '중복 재처리는 어댑터를 다시 호출하면 안 된다');
    assert.equal(watchStore.listNotificationDeliveries(user.user.id, job.id).filter((d) => d.idempotencyKey === fcmMethodKey).length, 1, '같은 idempotencyKey는 outbox에 행을 하나만 가져야 한다(재처리로 새 행이 생기면 안 됨)');

    // -- §6 재검토: 동시 dispatch 경쟁 조건 -- 완전히 새로운 idempotencyKey를
    // Promise.all로 10회 동시에 dispatch해도 어댑터는 정확히 1회만 호출돼야
    // 한다(claim이 동기적으로 단 한 호출자에게만 발급되므로, 나머지는
    // 어댑터를 절대 호출하지 않고 "sending"/"delivered" 상태의 같은 행만
    // 돌려받는다).
    const freshConcurrencyKey = `${job.id}:${state.foundCandidateId}:seat_found:webpush:${webpushDevice.id}:concurrency-fresh`;
    const beforeConcurrentCount = listInMemoryDeliveries().length;
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        dispatchNotification({
          userId: user.user.id, watchJobId: job.id, candidateId: state.foundCandidateId, channel: 'webpush', deviceId: webpushDevice.id, watchCycle: 0,
          eventType: 'seat_found', idempotencyKey: freshConcurrencyKey, destination: webpushDevice.token, deviceVerified: true, title: 't', body: 'b',
        }),
      ),
    );
    assert.equal(listInMemoryDeliveries().length, beforeConcurrentCount + 1, '10번 동시 dispatch해도 어댑터는 정확히 1회만 호출돼야 한다');
    assert.equal(concurrentResults.filter((r) => r.status === 'delivered').length, 1, '정확히 하나의 호출만 delivered로 끝나야 한다');
    assert.equal(concurrentResults.filter((r) => r.status === 'sending').length, 9, '나머지 9개는 claim을 얻지 못해 sending(선점됨) 상태의 같은 행을 받아야 한다');
    const freshRows = watchStore.listNotificationDeliveries(user.user.id, job.id).filter((d) => d.idempotencyKey === freshConcurrencyKey);
    assert.equal(freshRows.length, 1, '동시 호출 10회도 outbox 행을 하나만 만들어야 한다(경쟁 조건으로 여러 행이 생기면 안 됨)');
    assert.equal(freshRows[0].status, 'delivered', '경쟁에서 이긴 단 하나의 claim만 실제로 완료돼야 한다');
    assert.equal(freshRows[0].attemptCount, 1);

    // 서로 다른 기기/채널/watchCycle은 서로 다른 idempotencyKey를 가지므로
    // 각각 독립적으로 claim되어 각자 1회씩 발송돼야 한다(§6: 채널/기기/세대
    // 구분 없이 하나로 뭉뚱그려지면 안 됨 -- 이미 위 cycle0SeatFound 검증에서
    // fcm/webpush가 각각 1건씩 delivered인 것으로 확인했다).

    // -- "다시 감시" then re-drive to SEAT_FOUND: a NEW notification must go out (§6 재감시 요구사항) --
    const resumed = await watchJobResumeRoute.POST(req(`http://test/api/watch-jobs/${job.id}/resume`, { method: 'POST', cookie: user.cookie, clientId: 'block-flow-resume' }), { params: Promise.resolve({ id: job.id }) });
    const resumedJob = (await resumed.json()).job;
    assert.equal(resumedJob.status, 'WATCHING');
    assert.equal(resumedJob.watchCycle, 1, '다시 감시는 watchCycle을 증가시켜야 한다');

    state = await tick(4); // "never" again -> WATCHING
    state = await tick(5); // "appears" again -> SEAT_FOUND (a *second* logical seat_found event, new generation)
    assert.equal(state.status, 'SEAT_FOUND');
    assert.equal(state.watchCycle, 1);

    deliveries = watchStore.listNotificationDeliveries(user.user.id, job.id);
    const cycle1SeatFound = deliveries.filter((d) => d.eventType === 'seat_found' && d.watchCycle === 1);
    assert.equal(cycle1SeatFound.filter((d) => d.status === 'delivered').length, 2, '재감시 이후 같은 후보가 다시 발견되면 새 알림이 나가야 한다(이전 세대와 겹치지 않음)');
    assert.equal(listInMemoryDeliveries().length, 5, '누적 실제 발송 횟수: 1세대 2건 + 동시성 테스트 1건 + 2세대 2건');

    const confirmRes = await watchJobConfirmRoute.POST(req(`http://test/api/watch-jobs/${job.id}/confirm-booking`, { method: 'POST', cookie: user.cookie, clientId: 'block-flow-confirm' }), { params: Promise.resolve({ id: job.id }) });
    assert.equal(confirmRes.status, 200);
    assert.equal((await confirmRes.json()).job.status, 'COMPLETED');

    const reConfirm = await watchJobConfirmRoute.POST(req(`http://test/api/watch-jobs/${job.id}/confirm-booking`, { method: 'POST', cookie: user.cookie, clientId: 'block-flow-confirm' }), { params: Promise.resolve({ id: job.id }) });
    assert.equal(reConfirm.status, 409, 'confirming an already-COMPLETED job must be rejected, not silently repeat');

    // -- Device API list must never leak raw destinations, in JSON or via a naive string scan --
    const deviceListRes = await devicesRoute.GET(req('http://test/api/devices', { cookie: user.cookie }));
    const deviceListJson = await deviceListRes.json();
    for (const d of deviceListJson.devices) assert.equal('token' in d, false);
    const rawDump = JSON.stringify(deviceListJson);
    assert.equal(rawDump.includes('fcm-flow-token'), false);
    assert.equal(rawDump.includes('webpush-flow-token'), false);
    assert.equal(rawDump.includes('flow@example.com'), false, '이메일 원문도 목록 JSON에 있으면 안 된다');
    const auditDump = JSON.stringify(auditMemoryStore.memoryAuditStore.listForUser(user.user.id));
    assert.equal(auditDump.includes('fcm-flow-token'), false, '감사 로그에도 원문 토큰이 있으면 안 된다');
  });

  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    // -- error scenario: error_on_check surfaces a structured error, watching continues --
    resetAll();
    const user = await signup('err@example.com', 'block-err');
    const jobId = watchStore.createWatchJob(
      { ...baseJobInput(), userId: user.user.id, candidates: [{ externalKey: 'x', trainNumber: 'KTX 2', trainType: 'KTX', departAt: '2026-09-26T10:00:00+09:00', arriveAt: '2026-09-26T12:00:00+09:00', mockScenario: 'error_on_check' }] },
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
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
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
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'disabled', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
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

  // -- notification retry-on-failure + idempotency-on-success (outbox/claim model) --
  await withEnv({ ...DEV_STORES, NODE_ENV: 'test' }, async () => {
    resetAll();
    const user = await signup('notif@example.com', 'block-notif');
    const jobId = watchStore.createWatchJob({ ...baseJobInput(), userId: user.user.id }, 'mock').id;
    const key = 'retry-idem-test';
    const baseInput = { userId: user.user.id, watchJobId: jobId, candidateId: null, channel: 'email', deviceId: 'device-x', watchCycle: 0, eventType: 'seat_found', idempotencyKey: key, destination: 'notif@example.com', deviceVerified: true, title: 't', body: 'b' };

    await withEnv({ NODE_ENV: 'production' }, async () => {
      const failed = await dispatchNotification(baseInput);
      assert.equal(failed.status, 'failed', 'no real channel is configured in production, so the first attempt must fail closed');
      assert.equal(failed.attemptCount, 1);
    });

    assert.equal(watchStore.hasDeliveredNotification(user.user.id, key), false, 'a failed attempt must not be treated as delivered');

    // §6 재검토: 허용된 재시도는 정확히 1회만 다시 발송해야 한다.
    const delivered = await dispatchNotification(baseInput);
    assert.equal(delivered.status, 'delivered', 'the same idempotencyKey must be retryable after a failure, and now succeeds (dev/test uses the InMemory adapter)');
    assert.equal(delivered.attemptCount, 2, '실패(1회) 이후 재시도(2회째)로 성공해야 한다');
    assert.equal(listInMemoryDeliveries().length, 1, '재시도까지 포함해 어댑터는 정확히 1회만 실제로 호출돼야 한다');

    const dupe = await dispatchNotification(baseInput);
    assert.equal(dupe.status, 'delivered', 'a second delivery attempt with the same key after success must return the already-delivered row, not resend');
    assert.equal(dupe.attemptCount, 2, '이미 끝난 claim을 재처리해도 attemptCount가 증가하면 안 된다');
    assert.equal(listInMemoryDeliveries().length, 1, 'the adapter itself must only ever have been invoked once for this key');
  });

  // -- notification outbox lease: an unexpired claim blocks other workers,
  // an expired (abandoned) claim can be reclaimed for retry --
  await withEnv({ ...DEV_STORES, NODE_ENV: 'test', NOTIFICATION_CLAIM_LEASE_MS: '50' }, async () => {
    resetAll();
    const user = await signup('lease@example.com', 'block-lease');
    const jobId = watchStore.createWatchJob({ ...baseJobInput(), userId: user.user.id }, 'mock').id;
    const claimInput = { userId: user.user.id, watchJobId: jobId, candidateId: null, channel: 'email', deviceId: 'device-lease', watchCycle: 0, eventType: 'seat_found', idempotencyKey: 'lease-test' };

    const firstClaim = watchStore.claimNotification(claimInput);
    assert.equal(firstClaim.outcome, 'claimed');
    assert.equal(firstClaim.entry.attemptCount, 1);

    const secondClaim = watchStore.claimNotification(claimInput);
    assert.equal(secondClaim.outcome, 'already_claimed', '만료되지 않은 claim은 다른 Worker가 획득할 수 없어야 한다');
    assert.equal(secondClaim.entry.attemptCount, 1, '획득 실패는 attemptCount를 증가시키면 안 된다');

    await new Promise((resolve) => setTimeout(resolve, 120));

    const reclaim = watchStore.claimNotification(claimInput);
    assert.equal(reclaim.outcome, 'claimed', '만료된(방치된) claim은 재획득 가능해야 한다');
    assert.equal(reclaim.entry.attemptCount, 2, '재획득은 시도 횟수를 증가시켜야 한다');
  });

  // -- §1 검토사항(2차): claim fencing token -- 뒤늦게(stale) 도착한 완료가
  // 더 최신 claim(다른 Worker가 재획득한 것)을 덮어쓰면 안 된다. 실제
  // 타이머 기반 비동기 경쟁을 흉내 내지 않고, 저장소 함수(claimNotification/
  // completeNotificationClaim)를 직접 순서대로 호출해 결정적으로 재현한다.
  await withEnv({ ...DEV_STORES, NODE_ENV: 'test', NOTIFICATION_CLAIM_LEASE_MS: '50' }, async () => {
    resetAll();
    const user = await signup('fencing@example.com', 'block-fencing');
    const jobId = watchStore.createWatchJob({ ...baseJobInput(), userId: user.user.id }, 'mock').id;
    const claimInput = { userId: user.user.id, watchJobId: jobId, candidateId: null, channel: 'email', deviceId: 'device-fencing', watchCycle: 0, eventType: 'seat_found', idempotencyKey: 'fencing-test' };

    // 1) Worker A가 claim한다.
    const claimA = watchStore.claimNotification(claimInput);
    assert.equal(claimA.outcome, 'claimed');
    const tokenA = claimA.claimToken;

    // 2) A의 어댑터 호출이 오래 걸리는 상황을 흉내 낸다 -- 아직 완료를
    // 부르지 않은 채로 lease가 만료될 때까지 기다린다.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // 3) Worker B가 재획득한다 -- A와 반드시 다른 claimToken을 받아야 한다.
    const claimB = watchStore.claimNotification(claimInput);
    assert.equal(claimB.outcome, 'claimed');
    const tokenB = claimB.claimToken;
    assert.notEqual(tokenB, tokenA, '재획득은 항상 새 claimToken을 발급해야 한다');

    // 4) A가 뒤늦게 완료를 시도한다(이제는 stale) -- 거부되어야 하고, 저장된
    // 행을 전혀 건드리면 안 된다.
    const staleComplete = watchStore.completeNotificationClaim(user.user.id, 'fencing-test', tokenA, { delivered: true, deliveryRef: 'from-A' });
    assert.equal(staleComplete.applied, false);
    assert.equal(staleComplete.reason, 'stale_claim');
    assert.equal(staleComplete.entry.status, 'sending', 'stale completion 이후에도 행은 B가 보유 중인 sending 상태 그대로여야 한다');
    assert.equal(staleComplete.entry.claimToken, tokenB, 'stale completion이 B의 claimToken을 덮어쓰면 안 된다');
    // A가 실패로 완료를 시도해도 마찬가지로 거부돼야 한다(성공/실패 둘 다 막힘).
    const staleFailure = watchStore.completeNotificationClaim(user.user.id, 'fencing-test', tokenA, { delivered: false, deliveryRef: null, error: 'late failure from A' });
    assert.equal(staleFailure.applied, false);
    assert.equal(staleFailure.reason, 'stale_claim');

    // 5) B가 올바른 토큰으로 완료한다 -- 적용돼야 한다.
    const realComplete = watchStore.completeNotificationClaim(user.user.id, 'fencing-test', tokenB, { delivered: true, deliveryRef: 'from-B' });
    assert.equal(realComplete.applied, true);
    assert.equal(realComplete.entry.status, 'delivered');
    assert.equal(realComplete.entry.deliveryRef, 'from-B');
    assert.equal(realComplete.entry.claimToken, null, '완료 후에는 claimToken을 정리해야 한다');

    // 6) 최종 저장 상태는 B의 결과여야 한다(A의 결과가 아님).
    const finalRows = watchStore.listNotificationDeliveries(user.user.id, jobId).filter((d) => d.idempotencyKey === 'fencing-test');
    assert.equal(finalRows.length, 1, '동일 idempotencyKey에 대해 행이 하나만 있어야 한다');
    assert.equal(finalRows[0].deliveryRef, 'from-B');

    // 7) 완료된(delivered) 행은 다시 claim할 수 없다.
    const afterDeliveredClaim = watchStore.claimNotification(claimInput);
    assert.equal(afterDeliveredClaim.outcome, 'duplicate');

    // 8) 완료 후 A가 뒤늦게 또 완료를 시도해도(이제 status가 delivered) 여전히 거부된다.
    const staleAfterDelivered = watchStore.completeNotificationClaim(user.user.id, 'fencing-test', tokenA, { delivered: true, deliveryRef: 'from-A-too-late' });
    assert.equal(staleAfterDelivered.applied, false);
    assert.equal(staleAfterDelivered.entry.deliveryRef, 'from-B', '이미 delivered인 행이 stale 완료로 덮어써지면 안 된다');

    // 9) 서로 다른 사용자/기기/채널/watchCycle은 독립적으로 claim된다(서로 간섭하지 않음).
    const otherDeviceClaim = watchStore.claimNotification({ ...claimInput, deviceId: 'device-fencing-2', idempotencyKey: 'fencing-test-device2' });
    const otherChannelClaim = watchStore.claimNotification({ ...claimInput, channel: 'fcm', idempotencyKey: 'fencing-test-channel2' });
    const otherCycleClaim = watchStore.claimNotification({ ...claimInput, watchCycle: 1, idempotencyKey: 'fencing-test-cycle2' });
    assert.equal(otherDeviceClaim.outcome, 'claimed');
    assert.equal(otherChannelClaim.outcome, 'claimed');
    assert.equal(otherCycleClaim.outcome, 'claimed');
    assert.notEqual(otherDeviceClaim.claimToken, tokenB);
    assert.notEqual(otherChannelClaim.claimToken, tokenB);
    assert.notEqual(otherCycleClaim.claimToken, tokenB);
  });

  // -- production은 NOTIFICATION_CLAIM_LEASE_MS 테스트 오버라이드를 절대
  // 읽지 않는다 -- 항상 실제 30초 lease를 쓴다(fail-closed). --
  await withEnv({ NODE_ENV: 'production', NOTIFICATION_CLAIM_LEASE_MS: '50' }, () => {
    const claimInput = {
      userId: 'prod-lease-test-user', watchJobId: 'job-x', candidateId: null,
      channel: 'email', deviceId: 'device-x', watchCycle: 0, eventType: 'seat_found', idempotencyKey: 'prod-lease-key',
    };
    const claimed = watchStore.claimNotification(claimInput);
    assert.equal(claimed.outcome, 'claimed');
    const leaseMs = new Date(claimed.entry.lockExpiresAt).getTime() - new Date(claimed.entry.lockedAt).getTime();
    assert.ok(leaseMs > 1000, `production은 짧은 테스트 lease(50ms)를 무시하고 항상 긴(30초) lease를 써야 한다 (실제: ${leaseMs}ms)`);
  });

  // -- Production: Mock simulation is always blocked; ordinary job CRUD is not
  // (a user may legitimately register a watch before any Provider exists), as
  // long as the store itself is usable (dev/test here) --
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', ENABLE_MOCK_SEAT_SIMULATION: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const user = await signup('prod@example.com', 'block-prod');
    const deviceRes = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'prod@example.com' }, cookie: user.cookie, clientId: 'block-prod-device' }));
    const device = (await deviceRes.json()).device;
    const createRes = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: device.id }] }), cookie: user.cookie, clientId: 'block-prod-create' }));
    const job = (await createRes.json()).job;

    await withEnv({ NODE_ENV: 'production' }, async () => {
      const simBlocked = await watchJobSimulateRoute.POST(
        req(`http://test/api/watch-jobs/${job.id}/simulate`, { method: 'POST', body: { idempotencyKey: 'prod-1', tick: 3 }, cookie: user.cookie, clientId: 'block-prod-sim' }),
        { params: Promise.resolve({ id: job.id }) },
      );
      assert.equal(simBlocked.status, 503, 'Mock simulation must always be blocked in production, even with a syntactically valid tick');

      // §1 검토사항 반영 후 달라진 점: v0.5 최초 설계는 "Provider 미연결이어도
      // 인증만 되면 Production에서도 감시 작업 조회는 허용"이었지만, 이제는
      // AUTH_STORE가 Production에서 항상 사용 불가로 취급되므로 requireAuth
      // 자체가 먼저 실패한다 -- 영속 저장소가 실제로 연결되기 전까지는
      // Production에서 그 어떤 인증 필요 작업도 할 수 없다는 것이 지금의
      // 의도된(더 엄격해진) 동작이다.
      const listRes = await watchJobsRoute.GET(req('http://test/api/watch-jobs', { cookie: user.cookie }));
      assert.equal(listRes.status, 503, 'production에서는 AUTH_STORE_DISABLED로 인증 자체가 막혀야 한다');
      assert.equal((await listRes.json()).error.code, 'AUTH_STORE_DISABLED');

      const statusRes = await providerStatusRoute.GET();
      assert.equal(statusRes.status, 200, 'provider-status는 인증이 필요 없는 공개 엔드포인트라 여전히 응답해야 한다');
      const statusJson = await statusRes.json();
      assert.equal(statusJson.mockSimulationEnabled, false, 'provider-status must report simulation as unavailable in production regardless of the env flag');
      assert.equal(statusJson.watchStoreEnabled, false, 'production must report the watch store as unusable, matching the real fail-closed behavior');
    });

    const afterProd = await watchJobDetailRoute.GET(req(`http://test/api/watch-jobs/${job.id}`, { cookie: user.cookie }), { params: Promise.resolve({ id: job.id }) });
    assert.equal((await afterProd.json()).job.status, job.status, 'the production-blocked simulate call must not have mutated the job');
  });

  // -- account deletion cascades to watch data + pseudonymizes audit events
  // (including the auth-side user_signup/device_registered/watch_job_created
  // events that are now genuinely recorded -- §3 2차 검토) --
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  await withEnv({ ...DEV_STORES, SEAT_AVAILABILITY_PROVIDER: 'mock', ENABLE_SEAT_WATCH_JOBS: 'true', NODE_ENV: 'test' }, async () => {
    resetAll();
    const user = await signup('delete-me@example.com', 'block-delete');
    const userB = await signup('delete-me-b@example.com', 'block-delete-b');
    const deviceRes = await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'delete-me@example.com' }, cookie: user.cookie, clientId: 'block-delete-device' }));
    const device = (await deviceRes.json()).device;
    await devicesRoute.POST(req('http://test/api/devices', { method: 'POST', body: { channel: 'email', token: 'delete-me-b@example.com' }, cookie: userB.cookie, clientId: 'block-delete-device-b' }));
    const createRes = await watchJobsRoute.POST(req('http://test/api/watch-jobs', { method: 'POST', body: baseJobInput({ notificationMethods: [{ channel: 'email', deviceId: device.id }] }), cookie: user.cookie, clientId: 'block-delete-create' }));
    assert.equal(createRes.status, 201);
    assert.equal(watchStore.listWatchJobs(user.user.id).length, 1);
    // user_signup + device_registered + watch_job_created = 3 events so far.
    const auditCountBefore = auditMemoryStore.memoryAuditStore.listForUser(user.user.id).length;
    assert.equal(auditCountBefore, 3, 'signup + device 등록 + 감시작업 등록으로 3개의 감사 이벤트가 있어야 한다');
    const originalUserId = user.user.id;

    const deleteRes = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', body: { password: FAKE_PASSWORD }, cookie: user.cookie, clientId: 'block-delete-confirm' }));
    assert.equal(deleteRes.status, 200);
    assert.equal(watchStore.listWatchJobs(user.user.id).length, 0, 'account deletion must remove the user\'s watch jobs');
    assert.equal(auditMemoryStore.memoryAuditStore.listForUser(originalUserId).length, 0, '가명처리 후에는 원래 userId로 감사 이벤트를 찾을 수 없어야 한다');

    // §1 재검토: 가명은 실제 UUID 형식이어야 하고(Postgres audit_events.user_id
    // uuid 컬럼과 타입이 맞아야 함), 원래 userId와 달라야 하며, 같은 사용자의
    // 모든 이벤트(방금 추가된 user_deleted 포함)는 같은 가명을 공유해야 한다.
    // userB는 아직 삭제되지 않았으므로(자신의 실제 userId를 그대로 갖고 있어
    // UUID 형식 매칭에 걸리지 않음) 지금 시점에 UUID 형식 userId를 가진
    // 이벤트는 전부 방금 삭제된 A의 것이다.
    const pseudonymEventsA = auditMemoryStore.__listAllAuditEventsForTests().filter((e) => UUID_RE.test(e.userId));
    const candidatePseudonyms = new Set(pseudonymEventsA.map((e) => e.userId));
    assert.equal(candidatePseudonyms.size, 1, '삭제된 사용자의 모든 감사 이벤트는 정확히 하나의 공통 가명을 공유해야 한다');
    const pseudonymA = [...candidatePseudonyms][0];
    assert.ok(UUID_RE.test(pseudonymA), `가명은 유효한 UUID 형식이어야 한다: ${pseudonymA}`);
    assert.notEqual(pseudonymA, originalUserId, '가명은 원래 userId와 달라야 한다');
    assert.equal(pseudonymEventsA.length, auditCountBefore + 1, '기존 3개 + user_deleted 1개 = 4개 모두 동일한 가명으로 치환되어야 한다');
    assert.ok(
      pseudonymEventsA.some((e) => e.action === 'user_deleted'),
      'user_deleted 이벤트 자체도 다른 이전 이벤트들과 같은 가명을 공유해야 한다(가명처리보다 먼저 기록됐으므로)',
    );

    // 두 번째 계정을 삭제해 서로 다른 사용자가 서로 다른 가명을 받는지 확인한다.
    const originalUserIdB = userB.user.id;
    const auditCountBeforeB = auditMemoryStore.memoryAuditStore.listForUser(originalUserIdB).length;
    assert.ok(auditCountBeforeB > 0);
    const deleteResB = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', body: { password: FAKE_PASSWORD }, cookie: userB.cookie, clientId: 'block-delete-confirm-b' }));
    assert.equal(deleteResB.status, 200);
    const pseudonymEventsB = auditMemoryStore.__listAllAuditEventsForTests().filter((e) => UUID_RE.test(e.userId) && e.userId !== pseudonymA);
    const candidatePseudonymsB = new Set(pseudonymEventsB.map((e) => e.userId));
    assert.equal(candidatePseudonymsB.size, 1, '두 번째 삭제 계정도 자신만의 단일 가명을 가져야 한다');
    const pseudonymB = [...candidatePseudonymsB][0];
    assert.notEqual(pseudonymB, pseudonymA, '서로 다른 삭제 계정은 서로 다른 가명을 받아야 한다');

    const afterDelete = await sessionRoute.GET(req('http://test/api/auth/session', { cookie: user.cookie }));
    assert.equal(afterDelete.status, 401, 'the deleted account\'s session must no longer be valid');
  });

  // === §3(2차) 재검토: 인증 감사 이벤트(user_signup/login/logout/deleted) 실제 기록 ===
  await withEnv({ ...DEV_STORES, NODE_ENV: 'test' }, async () => {
    resetAll();

    // signup 성공 -> user_signup 정확히 1개. 중복 이메일 재가입(실패) 시도는 이벤트를 남기지 않는다.
    const user = await signup('audit-events@example.com', 'block-audit-signup');
    assert.equal(user.status, 201);
    let events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.deepEqual(events.map((e) => e.action), ['user_signup']);

    const dupSignup = await signup('audit-events@example.com', 'block-audit-signup');
    assert.equal(dupSignup.status, 409);
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.equal(events.length, 1, '중복 가입 실패는 성공 이벤트를 남기면 안 된다');

    // 잘못된 비밀번호 로그인 -> 이벤트 없음. 올바른 로그인 -> user_login 정확히 1개 추가.
    const badLogin = await login('audit-events@example.com', 'wrong-password-xyz', 'block-audit-login-bad');
    assert.equal(badLogin.status, 401);
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.equal(events.length, 1, '잘못된 비밀번호 로그인은 성공 이벤트를 남기면 안 된다');

    const goodLogin = await login('audit-events@example.com', FAKE_PASSWORD, 'block-audit-login-ok');
    assert.equal(goodLogin.status, 200);
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.deepEqual(events.map((e) => e.action), ['user_signup', 'user_login']);

    // 로그아웃 -> user_logout 정확히 1개 추가. 같은(이미 삭제된) 세션으로 재호출하거나
    // 세션이 전혀 없는 로그아웃은 중복/가짜 이벤트를 남기지 않는다(정책: 유효한 세션을
    // 실제로 무효화한 경우에만 기록).
    const logoutRes = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', cookie: goodLogin.cookie, clientId: 'block-audit-logout' }));
    assert.equal(logoutRes.status, 200);
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.deepEqual(events.map((e) => e.action), ['user_signup', 'user_login', 'user_logout']);

    const repeatLogout = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', cookie: goodLogin.cookie, clientId: 'block-audit-logout-again' }));
    assert.equal(repeatLogout.status, 200, '로그아웃 자체는 세션이 이미 없어도 항상 200을 반환해야 한다(idempotent)');
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.equal(events.length, 3, '이미 무효화된 세션으로의 재호출은 감사 이벤트를 추가로 남기면 안 된다');

    const noSessionLogout = await logoutRoute.POST(req('http://test/api/auth/logout', { method: 'POST', clientId: 'block-audit-logout-nosession' }));
    assert.equal(noSessionLogout.status, 200);
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.equal(events.length, 3, '쿠키가 아예 없는 로그아웃 호출도 감사 이벤트를 남기면 안 된다');

    // 다시 로그인해 계정 삭제 흐름을 검증한다: 잘못된 재인증은 이벤트를 남기지 않고,
    // 올바른 재인증만 user_deleted를 남긴다.
    const reLogin = await login('audit-events@example.com', FAKE_PASSWORD, 'block-audit-relogin');
    assert.equal(reLogin.status, 200);

    const badDelete = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', body: { password: 'wrong-one' }, cookie: reLogin.cookie, clientId: 'block-audit-delete-bad' }));
    assert.equal(badDelete.status, 401);
    events = auditMemoryStore.memoryAuditStore.listForUser(user.user.id);
    assert.equal(events.filter((e) => e.action === 'user_deleted').length, 0, '재인증 실패는 user_deleted를 남기면 안 된다');

    const goodDelete = await accountRoute.DELETE(req('http://test/api/auth/account', { method: 'DELETE', body: { password: FAKE_PASSWORD }, cookie: reLogin.cookie, clientId: 'block-audit-delete-ok' }));
    assert.equal(goodDelete.status, 200);
    // 삭제 후에는 (가명처리로) 원래 userId로 조회되지 않는다.
    assert.equal(auditMemoryStore.memoryAuditStore.listForUser(user.user.id).length, 0);
    const pseudonymized = auditMemoryStore.__listAllAuditEventsForTests().filter((e) => UUID_RE.test(e.userId));
    assert.equal(new Set(pseudonymized.map((e) => e.userId)).size, 1);
    assert.deepEqual(
      pseudonymized.map((e) => e.action).sort(),
      ['user_deleted', 'user_login', 'user_login', 'user_logout', 'user_signup'].sort(),
      '가입/로그인 2회/로그아웃/삭제 = 총 5개 이벤트가 모두 같은 가명으로 보존돼야 한다',
    );

    // §감사 이벤트 직렬화 결과에 이메일·비밀번호·세션 토큰이 없어야 한다.
    const dump = JSON.stringify(pseudonymized);
    assert.equal(dump.includes('audit-events@example.com'), false);
    assert.equal(dump.includes(FAKE_PASSWORD), false);
    assert.equal(dump.includes(goodLogin.cookie), false);
  });

  console.log = originalLog;
  console.error = originalError;

  assert.equal(fetchCalls, 0, 'the v0.5 auth/watch subsystem must never call fetch');
  const leaked = capturedLogs.some((line) => line.includes(FAKE_PASSWORD));
  assert.equal(leaked, false, 'no log line may contain a plaintext password');

  // §9 검토사항: Service Worker가 /api/**를 캐시하지 않는지 정적으로 재확인한다
  // (이 오프라인 스크립트에는 실제 브라우저/SW 실행 환경이 없으므로 텍스트 검사로 대체).
  const swSource = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  assert.ok(/\/api\//.test(swSource) && /return/.test(swSource), 'public/sw.js must still bypass /api/** from its cache logic');

  originalLog(JSON.stringify({ result: 'PASS', fetchCalls, capturedLogLines: capturedLogs.length }));
}

main().catch((error) => {
  console.error = originalError;
  originalError(error);
  process.exitCode = 1;
});
