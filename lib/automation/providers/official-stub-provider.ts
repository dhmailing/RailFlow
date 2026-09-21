import "server-only";

import { AutomationError, type SeatAutomationProvider } from "@/lib/automation/types";

// A future PR's seam for an officially-approved railway integration, once
// one exists (§3-D: "향후 공식 허용을 받은 연동용 Stub"). Every method throws
// OFFICIAL_INTEGRATION_REQUIRED unconditionally and never calls fetch,
// Playwright, or any other network/browser API -- mirrors v0.4's
// officialReservationProviderStub exactly. Nothing in this PR ever selects
// this Provider by default, and app/api routes additionally block creating
// a job against it (see app/api/automation-jobs/route.ts).
export const officialSeatAutomationProviderStub: SeatAutomationProvider = {
  name: "official",

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
    throw new AutomationError("OFFICIAL_INTEGRATION_REQUIRED", "공식 좌석 자동화 연동은 아직 승인되지 않았습니다.");
  },
  async clickPurchase() {
    throw new AutomationError("OFFICIAL_INTEGRATION_REQUIRED", "공식 좌석 자동화 연동은 아직 승인되지 않았습니다.");
  },
  async reserve() {
    throw new AutomationError("OFFICIAL_INTEGRATION_REQUIRED", "공식 좌석 자동화 연동은 아직 승인되지 않았습니다.");
  },
  async getReservation() {
    throw new AutomationError("OFFICIAL_INTEGRATION_REQUIRED", "공식 좌석 자동화 연동은 아직 승인되지 않았습니다.");
  },
  async cancelReservation() {
    throw new AutomationError("OFFICIAL_INTEGRATION_REQUIRED", "공식 좌석 자동화 연동은 아직 승인되지 않았습니다.");
  },
};
