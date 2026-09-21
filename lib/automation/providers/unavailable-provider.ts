import "server-only";

import { AutomationError, type SeatAutomationProvider } from "@/lib/automation/types";

// Production default (SEAT_AUTOMATION_PROVIDER=unavailable). Mirrors v0.5's
// unavailableSeatAvailabilityProvider: every call throws an honest
// NOT_CONFIGURED error instead of fabricating a result, and this file makes
// zero network calls and never touches Playwright.
export const unavailableSeatAutomationProvider: SeatAutomationProvider = {
  name: "unavailable",

  capabilities() {
    return {
      supportsAvailability: false,
      supportsPurchaseClick: false,
      supportsReservation: false,
      supportsCancellation: false,
      simulation: false,
    };
  },

  async searchAvailability() {
    throw new AutomationError("NOT_CONFIGURED", "자동화 Provider가 아직 연결되지 않았습니다.");
  },
  async clickPurchase() {
    throw new AutomationError("NOT_CONFIGURED", "자동화 Provider가 아직 연결되지 않았습니다.");
  },
  async reserve() {
    throw new AutomationError("NOT_CONFIGURED", "자동화 Provider가 아직 연결되지 않았습니다.");
  },
  async getReservation() {
    throw new AutomationError("NOT_CONFIGURED", "자동화 Provider가 아직 연결되지 않았습니다.");
  },
  async cancelReservation() {
    throw new AutomationError("NOT_CONFIGURED", "자동화 Provider가 아직 연결되지 않았습니다.");
  },
};
