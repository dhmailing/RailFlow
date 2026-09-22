import "server-only";

import { chromium, type Browser, type Page, type WebSocket } from "playwright";

import { assertPostNavigationTargetAllowed, buildAutomationTargetUrl, isAutomationTargetAllowed } from "@/lib/automation/host-guard";
import { AutomationError, type SeatAutomationProvider } from "@/lib/automation/types";

// The only Provider in this PR that actually drives a browser (§4). It is
// selected only when SEAT_AUTOMATION_PROVIDER=mock-browser AND
// isAutomationProviderUsable() (feature-flags.ts) -- both are checked by
// lib/automation/provider.ts before this module's methods are ever called,
// and every navigation additionally re-checks the host allowlist itself
// (host-guard.ts) so this file has no path to an external host even if
// those upstream checks were somehow bypassed.
//
// This Provider never accepts a URL, host, or port from a caller -- every
// target address is built internally by buildAutomationTargetUrl() from a
// fixed path plus IDs this module already has, never from user input.

// The pre-installed Chromium in this environment is pinned to a revision
// older than the `playwright` npm package's default expected build (see
// docs/V0.7-BOOKING-MACRO-SIMULATOR.md) -- launching with an explicit
// executablePath avoids Playwright trying (and failing) to download a
// matching browser at runtime. Overridable only for local dev machines that
// keep Playwright's browsers in the default cache location.
const CHROMIUM_EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";

// Playwright의 WebSocket 클래스는 관찰 전용 프록시라 close()를 제공하지
// 않는다 -- 연결을 직접 끊을 방법이 없으므로, 허용되지 않은 호스트로의
// WebSocket을 감지하면 즉시 browser.close()로 브라우저 프로세스 전체를
// 강제 종료한다(모든 페이지·연결이 함께 끊긴다). page.route()/context.route()
// 는 WebSocket 업그레이드 요청 자체를 가로채지 못하는 Playwright의 알려진
// 한계라 "전송 전 차단"이 아니라 "연결 성립 직후 즉시 차단"이다 -- 이
// fixture와 /demo/booking-simulator 페이지는 애초에 WebSocket을 전혀 쓰지
// 않으므로 지금은 도달할 일이 없는 방어 심화 계층이다. ws:/wss:는
// isAutomationTargetAllowed()가 http/https만 허용하므로 이 호출은 항상
// false를 반환해 사실상 "모든 WebSocket 차단"으로 동작한다.
function guardWebSocket(ws: WebSocket, browser: Browser): void {
  if (!isAutomationTargetAllowed(ws.url())) {
    void browser.close();
  }
}

async function withAutomationPage<T>(pathAndQuery: string, run: (page: Page) => Promise<T>): Promise<T> {
  // Throws AUTOMATION_TARGET_NOT_ALLOWED and never launches a browser at all
  // if the target is not allowed -- see host-guard.ts.
  const targetUrl = buildAutomationTargetUrl(pathAndQuery);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE_PATH, headless: true });
    // serviceWorkers: "block" -- 이 자동화가 여는 대상(/demo/booking-simulator)은
    // 현재 Service Worker를 등록하지 않지만(app/page.tsx의 "/"에서만 등록),
    // page.route()/context.route()는 Service Worker가 자체적으로 보내는
    // 요청을 가로채지 못하는 것이 Playwright의 알려진 한계다. 이 옵션으로
    // 이 컨텍스트에서는 Service Worker 등록 자체를 금지해, 향후 코드 변경으로
    // 이 페이지가 SW를 등록하게 되더라도 같은 우회 경로가 생기지 않도록 막는다.
    const context = await browser.newContext({ serviceWorkers: "block" });
    // context.route()는 page.route()와 달리 이 컨텍스트에서 열리는 새
    // 페이지·팝업(window.open, target="_blank" 등)에도 동일하게 적용된다 --
    // page 단위 등록은 원본 page 객체 하나만 보호하므로, 이 대상 페이지가
    // 팝업을 여는 경우 그 팝업의 요청은 차단 범위 밖에 있었다.
    await context.route("**/*", (route) => {
      const requestUrl = route.request().url();
      if (!isAutomationTargetAllowed(requestUrl)) {
        return route.abort();
      }
      return route.continue();
    });
    const activeBrowser = browser;
    context.on("page", (newPage) => newPage.on("websocket", (ws) => guardWebSocket(ws, activeBrowser)));

    const page = await context.newPage();
    page.on("websocket", (ws) => guardWebSocket(ws, activeBrowser));

    const response = await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 20_000 });

    // (§4 "리디렉션 후 호스트 재검증") Defense-in-depth on top of the
    // interceptor above: re-validate the browser's *actual* final address
    // before doing anything else.
    assertPostNavigationTargetAllowed(page.url());

    if (response && !response.ok()) {
      throw new AutomationError("CHECK_FAILED", `Mock 예매 사이트 응답 오류(HTTP ${response.status()}).`);
    }

    return await run(page);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

function listingLocator(page: Page, candidateId: string, testId: string) {
  return page.locator(`[data-testid="train-result"][data-listing-id="${candidateId}"] [data-testid="${testId}"]`);
}

// Polls a locator's attribute until it equals `expected` or `timeoutMs`
// elapses. Used instead of Playwright's `expect().toHaveAttribute()`
// (this PR only depends on the `playwright` core package, not
// `@playwright/test`'s assertion library).
async function waitForAttribute(locator: ReturnType<Page["locator"]>, name: string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await locator.getAttribute(name).catch(() => null);
    if (value === expected) return;
    if (Date.now() >= deadline) {
      throw new AutomationError("PURCHASE_CLICK_FAILED", `속성 ${name}이 ${timeoutMs}ms 내에 "${expected}"이 되지 않았습니다.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export const mockBrowserSeatAutomationProvider: SeatAutomationProvider = {
  name: "mock-browser",

  capabilities() {
    return {
      supportsAvailability: true,
      supportsPurchaseClick: true,
      supportsReservation: true,
      supportsCancellation: false,
      simulation: true,
    };
  },

  async searchAvailability({ candidate }) {
    return withAutomationPage(`/demo/booking-simulator?listingId=${encodeURIComponent(candidate.id)}`, async (page) => {
      const statusLocator = listingLocator(page, candidate.id, "seat-status");
      await statusLocator.waitFor({ state: "attached", timeout: 15_000 });
      const standard = Number(await statusLocator.getAttribute("data-standard-seats")) || 0;
      const special = Number(await statusLocator.getAttribute("data-special-seats")) || 0;
      const definitiveSoldOut = (await statusLocator.getAttribute("data-definitive-sold-out")) === "true";

      return {
        candidateId: candidate.id,
        available: standard > 0 || special > 0,
        seatClass: standard > 0 ? ("standard" as const) : special > 0 ? ("special" as const) : null,
        definitiveSoldOut,
        checkedAt: new Date().toISOString(),
        simulation: true,
      };
    });
  },

  async clickPurchase({ candidateId }) {
    return withAutomationPage(`/demo/booking-simulator?listingId=${encodeURIComponent(candidateId)}`, async (page) => {
      const purchaseButton = listingLocator(page, candidateId, "purchase-button");
      await purchaseButton.waitFor({ state: "visible", timeout: 15_000 });
      if (await purchaseButton.isDisabled()) {
        throw new AutomationError("PURCHASE_CLICK_FAILED", "구매 버튼이 비활성화되어 있습니다(좌석 없음).");
      }
      await purchaseButton.click();
      // The click's effect is server-persisted (MockListing.purchaseClicked)
      // and reflected back onto the seat-status element -- wait for that
      // round trip so a stale/failed click can never be reported as
      // succeeded.
      await waitForAttribute(listingLocator(page, candidateId, "seat-status"), "data-purchase-clicked", "true", 15_000);

      return { clicked: true, clickedAt: new Date().toISOString(), simulation: true };
    });
  },

  async reserve({ candidateId, idempotencyKey }) {
    return withAutomationPage(
      `/demo/booking-simulator?listingId=${encodeURIComponent(candidateId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
      async (page) => {
        const reserveButton = listingLocator(page, candidateId, "reserve-button");
        await reserveButton.waitFor({ state: "visible", timeout: 15_000 });
        await reserveButton.click();

        const resultLocator = listingLocator(page, candidateId, "reservation-result");
        await resultLocator.waitFor({ state: "attached", timeout: 15_000 });
        const reservationNumber = await resultLocator.getAttribute("data-reservation-number");
        const paymentDeadline = await resultLocator.getAttribute("data-payment-deadline");
        if (!reservationNumber || !paymentDeadline) {
          throw new AutomationError("RESERVE_FAILED", "예약 결과를 확인할 수 없습니다.");
        }

        return {
          reserved: true,
          candidateId,
          reservationNumber,
          paymentDeadline,
          simulation: true,
        };
      },
    );
  },

  async getReservation({ job }) {
    return { status: job.status, reservationNumber: job.reservationNumber, simulation: true };
  },

  async cancelReservation() {
    // Cancellation is intentionally not automated through the browser in
    // this PR (capabilities().supportsCancellation is false) -- a real
    // "cancel via the mock site's own UI" flow is left for a later PR.
    throw new AutomationError("NOT_CONFIGURED", "Mock 예약 취소 자동화는 아직 구현되지 않았습니다.");
  },
};
