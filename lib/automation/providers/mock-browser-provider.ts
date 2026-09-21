import "server-only";

import { chromium, type Browser, type Page } from "playwright";

import { assertPostNavigationTargetAllowed, buildAutomationTargetUrl } from "@/lib/automation/host-guard";
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

async function withAutomationPage<T>(pathAndQuery: string, run: (page: Page) => Promise<T>): Promise<T> {
  // Throws AUTOMATION_TARGET_NOT_ALLOWED and never launches a browser at all
  // if the target is not allowed -- see host-guard.ts.
  const targetUrl = buildAutomationTargetUrl(pathAndQuery);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM_EXECUTABLE_PATH, headless: true });
    const page = await browser.newPage();
    const response = await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 20_000 });

    // (§4 "리디렉션 후 호스트 재검증") goto() already followed any redirect
    // by the time it resolves -- re-validate the browser's *actual* final
    // address before doing anything else, in case a redirect landed
    // somewhere the allowlist does not cover.
    assertPostNavigationTargetAllowed(page.url());

    if (response && !response.ok()) {
      throw new AutomationError("CHECK_FAILED", `Mock 예매 사이트 응답 오류(HTTP ${response.status()}).`);
    }

    return await run(page);
  } finally {
    if (browser) await browser.close();
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
