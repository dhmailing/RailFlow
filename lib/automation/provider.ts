import "server-only";

import { getSeatAutomationProviderFlag, isAutomationProviderUsable, type SeatAutomationProviderFlag } from "@/lib/automation/feature-flags";
import { mockDirectSeatAutomationProvider } from "@/lib/automation/providers/mock-direct-provider";
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
  if (flag === "mock-direct" && isAutomationProviderUsable()) {
    // Never imports `playwright`; safe in every runtime this app can run
    // in, including this repo's own Cloudflare Workers build/dev path.
    return mockDirectSeatAutomationProvider;
  }
  if (flag === "mock-browser" && isAutomationProviderUsable()) {
    try {
      const mod = await import("@/lib/automation/providers/mock-browser-provider");
      return mod.mockBrowserSeatAutomationProvider;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeFailingProvider(
        new AutomationError("RUNTIME_NOT_SUPPORTED", `이 실행 환경은 실제 브라우저 자동화(Playwright)를 구동할 수 없습니다: ${message}`),
      );
    }
  }
  if (flag === "official") return officialSeatAutomationProviderStub;
  return unavailableSeatAutomationProvider;
}

// Lightweight, side-effect-cheap probe of whether the mock-browser Provider
// COULD load in this process, independent of whether it is currently
// selected -- used only by the provider-status API's `runtimeSupported`
// field (§3). Evaluating the module (an `import()`) never launches a real
// browser -- only calling one of its methods (which this never does) does
// that -- so this is safe to call on every status check. Memoized because
// the answer cannot change without a process restart (the runtime itself
// doesn't change), so repeated status polls don't repeatedly pay the import
// cost.
let cachedRuntimeSupport: Promise<boolean> | null = null;
export function checkMockBrowserRuntimeSupport(): Promise<boolean> {
  if (!cachedRuntimeSupport) {
    cachedRuntimeSupport = import("@/lib/automation/providers/mock-browser-provider")
      .then(() => true)
      .catch(() => false);
  }
  return cachedRuntimeSupport;
}
