import "server-only";

import type { BookingLaunchProvider } from "@/lib/watch/types";

const KORAIL_OFFICIAL_URL = "https://www.korail.com/";

// No officially-confirmed 코레일+ deep link scheme (custom URI or Android App
// Link) has been found (§F, PR #6's research). This provider never
// fabricates one -- `deepLinkAvailable` is always false and `appDeepLink` is
// always null. It only ever points at the same official web address v0.3
// already links to, plus a copyable trip-condition string so the user can
// paste it into 코레일+'s own search fields. Booking completion is never
// inferred here; the UI's "예매 완료" button is the only thing that marks a
// job COMPLETED (see lib/watch/worker.ts).
export const koreailWebFallbackBookingLaunchProvider: BookingLaunchProvider = {
  name: "korail-web-fallback",

  async launch(job, candidateId) {
    const candidate = job.candidates.find((item) => item.id === candidateId);
    const tripLine = candidate
      ? `${job.departure} → ${job.arrival} · ${job.date} · ${candidate.trainNumber} (${candidate.departAt.slice(11, 16)} 출발)`
      : `${job.departure} → ${job.arrival} · ${job.date}`;

    return {
      deepLinkAvailable: false,
      appDeepLink: null,
      webFallbackUrl: KORAIL_OFFICIAL_URL,
      copyText: tripLine,
    };
  },
};
