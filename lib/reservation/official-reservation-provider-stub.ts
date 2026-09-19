import "server-only";

import { ReservationProviderError, type RailReservationProvider } from "@/lib/reservation/types";

const NOT_READY =
  "공식 철도사(코레일+) 실시간 좌석·예약 연동은 공식 API·계약·서면 허용이 확인되지 않아 아직 제공되지 않습니다.";

// Placeholder for a future, officially-approved integration. It never opens a
// network connection, never accepts ALLOW_LIVE_RESERVATION (that flag is
// hardcoded false regardless, see feature-flags.ts), and every method fails
// closed with a structured error so callers can distinguish "not yet built"
// from a real provider failure.
export const officialReservationProviderStub: RailReservationProvider = {
  name: "official",

  capabilities() {
    return {
      supportsAvailability: false,
      supportsHold: false,
      supportsPayment: false,
      supportsCancellation: false,
      simulation: false,
    };
  },

  async checkAvailability() {
    throw new ReservationProviderError("OFFICIAL_INTEGRATION_REQUIRED", NOT_READY);
  },

  async reserve() {
    throw new ReservationProviderError("OFFICIAL_INTEGRATION_REQUIRED", NOT_READY);
  },

  async getReservation() {
    throw new ReservationProviderError("OFFICIAL_INTEGRATION_REQUIRED", NOT_READY);
  },

  async cancel() {
    throw new ReservationProviderError("OFFICIAL_INTEGRATION_REQUIRED", NOT_READY);
  },
};
