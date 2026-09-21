import "server-only";

import { listAllListings, registerListing } from "@/lib/automation/mock-booking-site/store";

// The exact three example candidates from the v0.7 spec (§3-A): candidate 1
// never opens up, candidate 2 opens a 일반실 seat on the 3rd check, candidate
// 3 opens a 특실 seat on the 5th check. Registering is idempotent -- calling
// this repeatedly (every request, since this module's state resets on every
// cold start like the rest of RailFlow's in-memory stores) never duplicates
// or resets an already-registered listing's checkCount.
const DEFAULT_LISTINGS = [
  {
    id: "mock-listing-1",
    trainNumber: "KTX 101",
    trainType: "KTX",
    departAt: "05:12",
    arriveAt: "07:48",
    fareLabel: "₩53,500",
    scenario: { kind: "always_sold_out" as const },
  },
  {
    id: "mock-listing-2",
    trainNumber: "KTX 107",
    trainType: "KTX",
    departAt: "06:40",
    arriveAt: "09:22",
    fareLabel: "₩53,500",
    scenario: { kind: "seat_after_n_checks" as const, checksRequired: 3, seatClass: "standard" as const },
  },
  {
    id: "mock-listing-3",
    trainNumber: "SRT 305",
    trainType: "SRT",
    departAt: "08:05",
    arriveAt: "10:31",
    fareLabel: "₩49,800",
    scenario: { kind: "seat_after_n_checks" as const, checksRequired: 5, seatClass: "special" as const },
  },
];

export function ensureMockBookingSiteSeeded(): void {
  if (listAllListings().length > 0) return;
  for (const listing of DEFAULT_LISTINGS) {
    registerListing(listing);
  }
}
