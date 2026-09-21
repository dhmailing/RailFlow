import "server-only";

import { getSeatAutomationProviderFlag, isAutomationProviderUsable, type SeatAutomationProviderFlag } from "@/lib/automation/feature-flags";
import { officialSeatAutomationProviderStub } from "@/lib/automation/providers/official-stub-provider";
import { unavailableSeatAutomationProvider } from "@/lib/automation/providers/unavailable-provider";
import { AutomationError, type SeatAutomationProvider } from "@/lib/automation/types";

export function getSeatAutomationProviderName(): SeatAutomationProviderFlag {
  return getSeatAutomationProviderFlag();
}

function makeFailingProvider(error: AutomationError): SeatAutomationProvider {
  return {
    name: "unavailable",
    capabilities: () => ({
      supportsAvailability: false,
      supportsPurchaseClick: false,
      supportsReservation: false,
      supportsCancellation: false,
      simulation: false,
    }),
    searchAvailability: () => Promise.reject(error),
    clickPurchase: () => Promise.reject(error),
    reserve: () => Promise.reject(error),
    getReservation: () => Promise.reject(error),
    cancelReservation: () => Promise.reject(error),
  };
}

// Mirrors lib/reservation/provider.ts's getReservationProvider() -- with one
// deliberate difference: this is async, because loading the "mock-browser"
// Provider means loading the real `playwright` package (see
// mock-browser-provider.ts), which some runtimes this app can be served
// from (this repo's own Cloudflare Workers dev/build path included -- see
// docs/V0.7-AUTOMATION-BOUNDARY.md §5) cannot evaluate at all (no
// `__dirname`/`child_process`). Loading it only inside this dynamic
// `import()`, and only when the flag actually selects it, means every other
// Provider (including the safe "unavailable" default that Production always
// forces) never touches that import and can never be crashed by it. A
// failed import is caught here and turned into an ordinary AutomationError
// the caller already knows how to handle -- never an unhandled crash.
export async function getSeatAutomationProvider(): Promise<SeatAutomationProvider> {
  const flag = getSeatAutomationProviderFlag();
  if (flag === "mock-browser" && isAutomationProviderUsable()) {
    try {
      const mod = await import("@/lib/automation/providers/mock-browser-provider");
      return mod.mockBrowserSeatAutomationProvider;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeFailingProvider(
        new AutomationError("NOT_CONFIGURED", `이 실행 환경은 실제 브라우저 자동화(Playwright)를 구동할 수 없습니다: ${message}`),
      );
    }
  }
  if (flag === "official") return officialSeatAutomationProviderStub;
  return unavailableSeatAutomationProvider;
}
