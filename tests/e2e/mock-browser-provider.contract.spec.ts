import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

import type { AutomationCandidate, AutomationJob, SeatAutomationProvider } from "@/lib/automation/types";

// This test file runs as an ES module (package.json "type": "module"), so a
// bare `require()` is not available -- createRequire() is the standard
// Node.js bridge for loading a CommonJS helper (load-ts.cjs) from ESM. See
// load-ts.cjs's header for why this loads mock-browser-provider.ts this way
// instead of a native `import`.
const require = createRequire(import.meta.url);
const { load } = require("./load-ts.cjs");

// Direct contract test of the REAL mock-browser Provider (§6 of the v0.7
// follow-up request: "mock-browser Provider 계약 테스트... 브라우저 실행 /
// 내부 시뮬레이터 접속 / data-testid 요소 확인 / 구매 클릭 / 예약 결과 확인
// / 외부 리디렉션 차단 / 브라우저 종료 보장"). Unlike
// scripts/verify-booking-simulator.cjs (which stands in a fake Provider for
// speed/determinism), this test calls the ACTUAL
// lib/automation/providers/mock-browser-provider.ts methods, which launch a
// REAL Chromium via Playwright and drive RailFlow's own /demo/booking-simulator
// page exactly like the real automation Worker does. This file runs under
// plain Node.js (the @playwright/test runner), never inside this repo's
// Cloudflare Workers dev/build path -- see docs/V0.7-AUTOMATION-BOUNDARY.md
// §5 for why that path cannot load `playwright` at all.
//
// Both value imports below go through load-ts.cjs rather than a native
// `import` -- lib/automation/host-guard.ts and .../mock-browser-provider.ts
// both start with `import "server-only"`, which Next.js/vinext's own
// compiler resolves to an empty module via the "react-server" export
// condition; a plain Node process (this test runner) does not set that
// condition, so a native import of these files throws the real
// `server-only` package's protective error. Type-only imports (above) are
// fully erased at compile time and never hit this problem.
const hostGuard = load("lib/automation/host-guard.ts") as {
  assertAutomationTargetAllowed: (rawUrl: string) => URL;
  assertPostNavigationTargetAllowed: (currentUrl: string) => URL;
  isAutomationTargetAllowed: (rawUrl: string) => boolean;
};
const mockBrowserProviderModule = load("lib/automation/providers/mock-browser-provider.ts") as {
  mockBrowserSeatAutomationProvider: SeatAutomationProvider;
};
const { assertAutomationTargetAllowed, assertPostNavigationTargetAllowed, isAutomationTargetAllowed } = hostGuard;
const { mockBrowserSeatAutomationProvider } = mockBrowserProviderModule;

function fakeCandidate(id: string): AutomationCandidate {
  return { id, trainNumber: "TEST", trainType: "KTX", departAt: "00:00", arriveAt: "00:00", fareLabel: "₩0" };
}

// Only the fields mock-browser-provider.ts's methods actually read are
// populated meaningfully; the rest are structurally required by
// AutomationJob but unused by this Provider.
function fakeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: "contract-test-job",
    userId: "contract-test-user",
    departure: "동탄",
    arrival: "울산(통도사)",
    date: "2026-01-01",
    timeRangeStart: "05:00",
    timeRangeEnd: "10:00",
    passengers: 1,
    seatClassPreference: "any",
    candidates: [],
    watchUntil: new Date(Date.now() + 600_000).toISOString(),
    intervalSeconds: 1,
    status: "WATCHING",
    provider: "mock-browser",
    simulation: true,
    watchCycle: 1,
    attempts: 0,
    lastCheckedAt: null,
    nextCheckAt: null,
    seatFoundAt: null,
    purchaseClickedAt: null,
    reservedAt: null,
    heldCandidateId: null,
    reservationNumber: null,
    paymentDeadline: null,
    definitiveSoldOutCandidateIds: [],
    stepClaimToken: null,
    stepLockExpiresAt: null,
    reservedForCycle: null,
    notifiedForCycle: null,
    lastError: null,
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test.describe("mock-browser Provider 계약 테스트 (실제 Playwright 브라우저)", () => {
  test("candidate 1(항상 매진)은 definitiveSoldOut을 보고한다", async () => {
    const result = await mockBrowserSeatAutomationProvider.searchAvailability({
      job: fakeJob(),
      candidate: fakeCandidate("mock-listing-1"),
    });
    expect(result.available).toBe(false);
    expect(result.definitiveSoldOut).toBe(true);
    expect(result.simulation).toBe(true);
  });

  test("candidate 2는 3번째 확인에서 좌석을 보고하고, 구매클릭·예약까지 실제 브라우저로 완료된다", async () => {
    test.setTimeout(60_000);
    const candidateId = "mock-listing-2";
    const candidate = fakeCandidate(candidateId);
    const job = fakeJob();

    let lastResult;
    for (let i = 0; i < 3; i += 1) {
      lastResult = await mockBrowserSeatAutomationProvider.searchAvailability({ job, candidate });
    }
    expect(lastResult!.available).toBe(true);
    expect(lastResult!.seatClass).toBe("standard");

    // 실제 브라우저로 구매 버튼을 클릭한다 -- data-purchase-clicked 속성이
    // "true"가 될 때까지 대기하는 실제 폴링을 거친다(mock-browser-provider.ts
    // 내부, 좌표 클릭이 아니라 data-testid locator만 사용).
    const clickResult = await mockBrowserSeatAutomationProvider.clickPurchase({ job, candidateId });
    expect(clickResult.clicked).toBe(true);

    const idempotencyKey = `contract-test-${Date.now()}`;
    const reserveResult = await mockBrowserSeatAutomationProvider.reserve({ job, candidateId, idempotencyKey });
    expect(reserveResult.reserved).toBe(true);
    expect(reserveResult.reservationNumber).toMatch(/^RF-[0-9A-F]{8}$/);
    expect(reserveResult.paymentDeadline).toBeTruthy();

    // 동일 idempotencyKey로 재시도해도 같은 예약이 반환된다(§6 동시성).
    const retryResult = await mockBrowserSeatAutomationProvider.reserve({ job, candidateId, idempotencyKey });
    expect(retryResult.reservationNumber).toBe(reserveResult.reservationNumber);
  });

  test("브라우저 종료 보장 -- 연속 호출이 서로 간섭하지 않는다", async () => {
    // withAutomationPage()의 finally { browser.close() }가 실제로 실행되지
    // 않으면(예: 브라우저 프로세스가 남아있으면) 후속 호출이 실패하거나
    // 극단적으로 느려질 수 있다. 세 번 연속 성공은 매번 브라우저가 깨끗하게
    // 종료되고 있다는 간접 증거다.
    for (let i = 0; i < 3; i += 1) {
      const result = await mockBrowserSeatAutomationProvider.searchAvailability({ job: fakeJob(), candidate: fakeCandidate("mock-listing-1") });
      expect(result.definitiveSoldOut).toBe(true);
    }
  });

  test("외부 URL/리디렉션 차단 -- host-guard가 실제로 korail.com을 거부한다", () => {
    expect(() => assertAutomationTargetAllowed("https://www.korail.com/")).toThrow(/허용되지 않은 자동화 대상 호스트/);
    expect(() => assertAutomationTargetAllowed("https://letskorail.com/ticket")).toThrow(/허용되지 않은 자동화 대상 호스트/);
    expect(() => assertPostNavigationTargetAllowed("https://evil.example.com/demo/booking-simulator")).toThrow(/허용되지 않은 자동화 대상 호스트/);
    // 허용되는 주소는 통과해야 한다.
    expect(() => assertAutomationTargetAllowed("http://localhost:3000/demo/booking-simulator")).not.toThrow();
  });

  // §6 후속: "페이지를 연 뒤 URL만 검사하는 방식으로 외부 요청 차단이
  // 충분하다고 판단하지 마라" -- mock-browser-provider.ts의
  // withAutomationPage()가 실제로 등록하는 것과 동일한 page.route()
  // 패턴(isAutomationTargetAllowed로 매 요청을 판정해 허용되지 않으면
  // route.abort())을 이 테스트에서도 직접 재현해, 허용되지 않은 호스트로의
  // "탐색 요청 자체"가 브라우저를 떠나기 전에 중단되는지 확인한다(탐색이
  // 끝난 뒤 최종 URL만 사후 검사하는 것과는 다른 보장이다).
  test("요청 레벨 차단 -- 허용되지 않은 호스트로의 요청은 전송되기 전에 중단된다", async ({ browser }) => {
    const page = await browser.newPage();
    try {
      let sawDisallowedRequest = false;
      await page.route("**/*", (route) => {
        const requestUrl = route.request().url();
        if (!isAutomationTargetAllowed(requestUrl)) {
          sawDisallowedRequest = true;
          return route.abort();
        }
        return route.continue();
      });

      let navigationError: unknown = null;
      try {
        await page.goto("https://www.korail.com/", { timeout: 8_000 });
      } catch (error) {
        navigationError = error;
      }

      expect(navigationError, "허용되지 않은 호스트로의 탐색은 route.abort()로 실패해야 한다(성공하면 안 됨)").not.toBeNull();
      expect(sawDisallowedRequest).toBe(true);
    } finally {
      await page.close();
    }

    // 대조군: 허용되는 주소(localhost)는 같은 인터셉터 패턴 아래에서도 정상
    // 통과해야 한다 -- 인터셉터 자체가 모든 요청을 막는 게 아님을 확인한다.
    // 실패한 탐색이 크롬 내부 오류 페이지로 전환되는 것과 경합하지 않도록
    // 별도의 새 page를 쓴다(withAutomationPage()가 호출마다 새 page를 쓰는
    // 것과 동일한 방식).
    const controlPage = await browser.newPage();
    try {
      await controlPage.route("**/*", (route) => {
        const requestUrl = route.request().url();
        return isAutomationTargetAllowed(requestUrl) ? route.continue() : route.abort();
      });
      await controlPage.goto("http://localhost:3000/demo/booking-simulator", { timeout: 15_000 });
      expect(controlPage.url()).toContain("localhost:3000");
    } finally {
      await controlPage.close();
    }
  });
});
