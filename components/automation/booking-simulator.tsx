"use client";

// RailFlow's own fake booking site UI (§3-A). Every data-testid here is
// exactly what lib/automation/providers/mock-browser-provider.ts's real
// Playwright automation selects -- train-result / seat-status /
// purchase-button / reserve-button / reservation-result. No coordinate
// clicks, OCR, or image matching anywhere in this codebase target this
// page; automation always goes through these selectors (§4).
//
// This page calls ONLY RailFlow's own /api/automation/mock-site/** routes.
// It never calls TAGO, KORAIL, SR, or any real railway/payment API.
import { useEffect, useState } from "react";
import Link from "next/link";
import { LoaderCircle, ShieldAlert, Sparkles, TicketCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Listing = { id: string; trainNumber: string; trainType: string; departAt: string; arriveAt: string; fareLabel: string };
type SeatStatus = {
  listingId: string;
  standardSeats: number;
  specialSeats: number;
  soldOut: boolean;
  definitiveSoldOut: boolean;
  checkedAt: string;
  checkCount: number;
  purchaseClicked: boolean;
};
type Reservation = { id: string; listingId: string; seatClass: "standard" | "special"; reservationNumber: string; paymentDeadline: string; cancelledAt: string | null };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export default function BookingSimulator() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [statusByListing, setStatusByListing] = useState<Record<string, SeatStatus>>({});
  const [clickedByListing, setClickedByListing] = useState<Record<string, boolean>>({});
  const [reservationByListing, setReservationByListing] = useState<Record<string, Reservation>>({});
  const [busyListingId, setBusyListingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 자동화 Worker가 내비게이션 쿼리로 넘기는 값(§4) -- Suspense 없이도 안전한
  // window.location 기반 파싱으로 읽는다(useSearchParams는 정적 렌더링과
  // 충돌할 수 있어 피한다).
  const [focusListingId, setFocusListingId] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | undefined>(undefined);
  const [queryReady, setQueryReady] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const query = new URLSearchParams(window.location.search);
      setFocusListingId(query.get("listingId"));
      setIdempotencyKey(query.get("idempotencyKey") ?? undefined);
      setQueryReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!queryReady) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/automation/mock-site/listings", { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setEnabled(false);
          return;
        }
        const payload = await readJson<{ listings: Listing[] }>(response);
        if (cancelled) return;
        setEnabled(true);
        setListings(payload.listings);
        // 자동화 Worker와 동일한 동작: 목록을 불러온 뒤 각 열차의 좌석
        // 상태를 한 번 확인한다(§data-testid="seat-status"). listingId
        // query가 있으면 그 열차만 우선 확인한다.
        const targets = focusListingId ? payload.listings.filter((listing) => listing.id === focusListingId) : payload.listings;
        for (const listing of targets) {
          void checkStatus(listing.id);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryReady, focusListingId]);

  const checkStatus = async (listingId: string) => {
    const response = await fetch(`/api/automation/mock-site/listings/${listingId}/status`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await readJson<{ status: SeatStatus }>(response);
    setStatusByListing((current) => ({ ...current, [listingId]: payload.status }));
  };

  const clickPurchase = async (listingId: string) => {
    setBusyListingId(listingId);
    try {
      const response = await fetch(`/api/automation/mock-site/listings/${listingId}/purchase-click`, { method: "POST" });
      if (response.ok) {
        setClickedByListing((current) => ({ ...current, [listingId]: true }));
        // seat-status의 data-purchase-clicked는 status(서버에서 마지막으로
        // 가져온 값)를 clicked 로컬 state보다 우선한다(아래 렌더링) --
        // 클릭 후 다시 조회하지 않으면 이 속성이 계속 stale한 "false"로
        // 남아, 실제 Playwright 자동화(mock-browser-provider.ts의
        // waitForAttribute)가 절대 만족되지 않는 값을 기다리다 타임아웃하는
        // 실제 결함이 있었다 -- 클릭 성공 즉시 서버 상태를 다시 가져온다.
        void checkStatus(listingId);
      }
    } finally {
      setBusyListingId(null);
    }
  };

  const reserve = async (listingId: string) => {
    const status = statusByListing[listingId];
    if (!status) return;
    const seatClass = status.standardSeats > 0 ? "standard" : "special";
    setBusyListingId(listingId);
    try {
      const response = await fetch(`/api/automation/mock-site/listings/${listingId}/reserve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatClass, idempotencyKey: idempotencyKey ?? crypto.randomUUID() }),
      });
      const payload = await readJson<{ reservation?: Reservation }>(response);
      if (response.ok && payload.reservation) {
        setReservationByListing((current) => ({ ...current, [listingId]: payload.reservation! }));
        void checkStatus(listingId);
      }
    } finally {
      setBusyListingId(null);
    }
  };

  if (enabled === false) {
    return (
      <main className="min-h-dvh bg-[#070707] text-white">
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <ShieldAlert className="mx-auto mb-4 size-10 text-white/30" />
          <h1 className="text-xl font-extrabold">Mock 예매 시뮬레이터가 비활성화되어 있습니다</h1>
          <p className="mt-2 text-sm text-white/50">운영(Production) 환경이거나 서버에서 아직 켜지지 않았습니다. 개발/Preview 환경에서 다시 시도해주세요.</p>
          <Link href="/" className="mt-6 inline-block text-sm font-bold text-[#ff8a1f] underline">
            RailFlow로 돌아가기
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#070707] text-white">
      <div className="mx-auto min-h-dvh max-w-3xl border-x border-white/[0.06] pb-16">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#070707]/95 backdrop-blur-xl">
          <div className="flex items-center justify-between px-4 py-3 sm:px-6">
            <Link href="/" className="text-sm font-bold text-white/60 hover:text-white">
              ← RailFlow로 돌아가기
            </Link>
            <span className="text-xs font-bold text-white/40">Mock Booking Simulator</span>
          </div>
          <div className="flex items-center gap-2 border-t border-white/[0.06] bg-[#ff8a1f]/[0.08] px-4 py-2.5 text-xs font-bold text-[#ffad62] sm:px-6">
            <Sparkles className="size-4 shrink-0" />
            RailFlow가 관리하는 가상 예매 사이트 · 실제 코레일/SR 사이트가 아닙니다
          </div>
        </header>

        <div className="space-y-4 px-4 pt-5 sm:px-6">
          <div>
            <h1 className="text-2xl font-extrabold tracking-[-0.03em]">Mock 예매 사이트</h1>
            <p className="mt-2 text-sm leading-6 text-white/45">
              자동 좌석조회·예약 매크로가 이 화면의 버튼을 실제 브라우저로 클릭하며 시연됩니다. 여기서 발급되는 열차·좌석·예약번호는 전부
              가상 데이터이며, 코레일·SR 등 실제 사이트로 어떤 요청도 전달되지 않습니다.
            </p>
          </div>

          {loading ? (
            <p role="status" className="text-sm text-white/50">
              <LoaderCircle className="mb-1 inline size-4 animate-spin" /> 열차 목록을 불러오는 중
            </p>
          ) : (
            <div className="space-y-3">
              {listings.map((listing) => {
                const status = statusByListing[listing.id];
                const clicked = clickedByListing[listing.id] ?? false;
                const reservation = reservationByListing[listing.id];
                const hasSeat = !!status && (status.standardSeats > 0 || status.specialSeats > 0);
                const busy = busyListingId === listing.id;
                return (
                  <Card key={listing.id} data-testid="train-result" data-listing-id={listing.id} className="rounded-[24px] border-white/10 bg-[#111]/90 py-0 text-white">
                    <CardContent className="space-y-3 p-4 sm:p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[11px] font-bold text-white/60">{listing.trainType}</span>
                          <span className="ml-2 text-sm font-bold">{listing.trainNumber}</span>
                        </div>
                        <span className="text-xs text-white/40">{listing.fareLabel}</span>
                      </div>
                      <p className="text-sm text-white/60">
                        {listing.departAt} 출발 → {listing.arriveAt} 도착
                      </p>

                      <div
                        data-testid="seat-status"
                        data-standard-seats={status?.standardSeats ?? 0}
                        data-special-seats={status?.specialSeats ?? 0}
                        data-definitive-sold-out={status?.definitiveSoldOut ?? false}
                        data-check-count={status?.checkCount ?? 0}
                        data-purchase-clicked={status?.purchaseClicked ?? clicked}
                        className={`rounded-xl border px-3 py-2 text-xs font-bold ${hasSeat ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-white/10 bg-black/25 text-white/45"}`}
                      >
                        {!status
                          ? "확인 필요"
                          : hasSeat
                            ? `일반실 ${status.standardSeats}석 · 특실 ${status.specialSeats}석 (확인 ${status.checkCount}회차)`
                            : status.definitiveSoldOut
                              ? `매진(재판매 없음, 확인 ${status.checkCount}회차)`
                              : `매진(확인 ${status.checkCount}회차)`}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => checkStatus(listing.id)} className="rounded-lg border-white/15 text-white/60">
                          좌석 다시 확인
                        </Button>
                        <Button
                          data-testid="purchase-button"
                          size="sm"
                          disabled={!hasSeat || busy || !!reservation}
                          onClick={() => clickPurchase(listing.id)}
                          className="rounded-lg bg-[#ff8a1f] font-bold text-black hover:bg-[#ff9d45] disabled:opacity-30"
                        >
                          구매
                        </Button>
                        {(clicked || status?.purchaseClicked) && !reservation && (
                          <Button
                            data-testid="reserve-button"
                            size="sm"
                            disabled={busy}
                            onClick={() => reserve(listing.id)}
                            className="rounded-lg bg-emerald-400 font-bold text-black hover:bg-emerald-300"
                          >
                            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <TicketCheck className="size-4" />} 예약 요청
                          </Button>
                        )}
                      </div>

                      {reservation && (
                        <div
                          data-testid="reservation-result"
                          data-reservation-number={reservation.reservationNumber}
                          data-payment-deadline={reservation.paymentDeadline}
                          className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-200"
                        >
                          가상 예약번호 {reservation.reservationNumber} · 결제기한{" "}
                          {new Date(reservation.paymentDeadline).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
