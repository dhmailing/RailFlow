"use client";

// v0.9 서버형 자동예약 패널.
//
// 지금 이 패널이 하는 일은 하나다: **무엇이 준비됐고 무엇이 없어서 못
// 하는지를 정직하게 보여주는 것.**
//
// 실제 Provider 가 없으므로 작업을 만들 수 없다. 그 사실을 숨기고 입력
// 폼만 띄우면 사용자는 "등록했는데 왜 아무 일도 안 일어나지?"를 겪는다.
// Mock 결과를 실제처럼 보여주지도 않는다.

import { useEffect, useState } from "react";
import { CircleCheck, CircleDashed, CircleSlash, ShieldQuestion } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

type AutobookStatus = {
  runtime: {
    killSwitch: boolean;
    provider: string;
    store: string;
    storeUsable: boolean;
    jobsEnabled: boolean;
    liveReservationPossible: boolean;
    simulation: boolean;
  };
  provider: {
    name: string;
    capabilities: {
      canReadAvailability: boolean;
      canCreateReservation: boolean;
      canVerifyReservation: boolean;
      simulation: boolean;
    };
    rateLimit: { minIntervalSeconds: number; basis: string };
  };
  accountLink: {
    anyAvailable: boolean;
    summary: string;
    methods: Array<{ method: string; available: boolean; blockedReason: string }>;
  };
  note: string;
};

const METHOD_LABEL: Record<string, string> = {
  official_oauth: "공식 OAuth·파트너 토큰",
  official_api_credential: "공식 API credential",
  short_lived_session: "사용자가 직접 갱신하는 단기 세션",
};

/**
 * 현재 상태 4종.
 *
 * "준비된 것"과 "하지 않는 것"을 한 덩어리에 섞어 놓으면 사용자는 전체가
 * 동작한다고 읽는다. 그래서 상태를 네 줄로 못박아 맨 위에 둔다.
 */
function StateLine({
  tone,
  label,
  detail,
  testId,
}: {
  tone: "ready" | "missing";
  label: string;
  detail: string;
  testId: string;
}) {
  return (
    <li data-testid={testId} className="flex items-start gap-2">
      {tone === "ready" ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
      ) : (
        <CircleSlash className="mt-0.5 size-4 shrink-0 text-amber-400/80" />
      )}
      <span className="min-w-0">
        <span
          className={
            tone === "ready"
              ? "block text-sm font-bold leading-6 text-white/80"
              : "block text-sm font-bold leading-6 text-amber-200/90"
          }
        >
          {label}
        </span>
        <span className="block text-xs leading-5 text-white/40">{detail}</span>
      </span>
    </li>
  );
}

function Ready({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm leading-6">
      {ok ? (
        <CircleCheck className="mt-1 size-4 shrink-0 text-emerald-400" />
      ) : (
        <CircleDashed className="mt-1 size-4 shrink-0 text-white/30" />
      )}
      <span className={ok ? "text-white/75" : "text-white/45"}>{children}</span>
    </li>
  );
}

export default function AutobookPanel() {
  const [status, setStatus] = useState<AutobookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/autobook/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<AutobookStatus>)
      .then((data) => {
        if (alive) setStatus(data);
      })
      .catch(() => {
        if (alive) setError("자동예약 상태를 불러오지 못했습니다.");
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card data-testid="autobook-panel" className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-40 text-sm font-extrabold">서버형 자동예약</p>
          {/* 실제 연동이 없다는 사실을 배지로 못박는다. */}
          <span
            data-testid="autobook-readiness"
            className="shrink-0 max-w-full whitespace-normal rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-bold leading-4 text-white/60"
          >
            {status?.runtime.liveReservationPossible ? "실제 연동 활성" : "공식 연동 준비 중"}
          </span>
        </div>

        <p className="text-sm leading-6 text-white/60">
          좌석이 나오면 서버가 대신 확보하고, <strong>결제는 사용자가 공식 앱에서 직접</strong> 합니다. RailFlow는
          결제를 대신하지 않습니다.
        </p>

        {error && <p className="text-sm leading-6 text-red-300">{error}</p>}

        {status && (
          <>
            {/* §7: 네 가지 상태를 흐리지 않고 그대로 쓴다. */}
            <ul data-testid="autobook-state-summary" className="space-y-2.5 rounded-2xl border border-white/10 bg-black/25 p-3">
              <StateLine
                testId="autobook-state-foundation"
                tone="ready"
                label="서버형 자동예약 기반 준비됨"
                detail="상태 기계 · 분산 락 · 펜싱 토큰 · 멱등키 · Outbox · 요청 제한 · 강제 중단 스위치"
              />
              <StateLine
                testId="autobook-state-provider"
                tone={status.provider.capabilities.canCreateReservation ? "ready" : "missing"}
                label={
                  status.provider.capabilities.canCreateReservation
                    ? "실제 좌석 Provider 연결됨"
                    : "실제 좌석 Provider 미연결"
                }
                detail={`현재 Provider: ${status.provider.name}${
                  status.provider.capabilities.simulation ? " (시뮬레이션 — 실제 좌석이 아닙니다)" : ""
                }`}
              />
              <StateLine
                testId="autobook-state-account"
                tone={status.accountLink.anyAvailable ? "ready" : "missing"}
                label={status.accountLink.anyAvailable ? "계정 연결 가능" : "계정 연결 비활성"}
                detail="공식 연결 방식이 확인되기 전까지 켜지 않습니다. 비밀번호를 받는 기능 자체가 없습니다."
              />
              <StateLine
                testId="autobook-state-live"
                tone="missing"
                label="실제 좌석 조회·예약을 수행하지 않음"
                detail="이 화면과 서버는 코레일·SR에 실제 조회·예약 요청을 보내지 않습니다."
              />
            </ul>

            <div className="space-y-2 rounded-2xl border border-white/10 bg-black/25 p-3">
              <p className="flex items-start gap-2 text-sm font-bold text-white/80">
                <ShieldQuestion className="mt-0.5 size-4 shrink-0" />
                계정 연결
              </p>
              <p className="text-sm leading-6 text-white/55">{status.accountLink.summary}</p>
              <ul className="space-y-1">
                {status.accountLink.methods.map((entry) => (
                  <Ready key={entry.method} ok={entry.available}>
                    {METHOD_LABEL[entry.method] ?? entry.method}
                    {!entry.available && (
                      <span className="block text-xs leading-5 text-white/30">{entry.blockedReason}</span>
                    )}
                  </Ready>
                ))}
              </ul>
            </div>

            {/* §7: 후보 선택은 위 검색 화면에서 가능하다. 등록은 막는다. */}
            <div className="space-y-2 rounded-2xl border border-white/10 bg-black/25 p-3">
              <p className="text-sm font-bold text-white/80">실제 감시 작업 등록</p>
              <button
                type="button"
                data-testid="autobook-create-job"
                disabled
                aria-describedby="autobook-disabled-reasons"
                className="w-full cursor-not-allowed rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-extrabold text-white/30"
              >
                실제 감시 작업 등록 (비활성)
              </button>
              <p className="text-xs leading-5 text-white/40">
                열차를 후보로 고르는 것은 위 검색 화면에서 지금도 됩니다. 아래 세 가지가 모두 갖춰지기 전까지
                실제 작업은 등록되지 않습니다.
              </p>
              <ul id="autobook-disabled-reasons" data-testid="autobook-disabled-reasons" className="space-y-1">
                <Ready ok={status.provider.capabilities.canCreateReservation}>
                  {status.provider.capabilities.canCreateReservation ? "공식 연동 Provider 확보됨" : "공식 연동 Provider 없음"}
                  <span className="block text-xs leading-5 text-white/30">
                    좌석 조회·예약을 지원하는 공개·승인된 연동 명세를 확보하지 못했습니다.
                  </span>
                </Ready>
                <Ready ok={status.runtime.store === "postgres"}>
                  {status.runtime.store === "postgres" ? "영속 DB 어댑터 연결됨" : "영속 DB 어댑터 없음"}
                  <span className="block text-xs leading-5 text-white/30">
                    현재 저장소는 <span className="font-mono">{status.runtime.store}</span> 입니다. Postgres 어댑터가
                    없으면 서버가 여러 대일 때 감시 작업이 유지되지 않습니다.
                  </span>
                </Ready>
                <Ready ok={status.accountLink.anyAvailable}>
                  {status.accountLink.anyAvailable ? "계정 연결 방식 확인됨" : "계정 연결 방식 없음"}
                  <span className="block text-xs leading-5 text-white/30">
                    공식 OAuth · 공식 API credential · 단기 세션 중 확인된 것이 없습니다.
                  </span>
                </Ready>
              </ul>
            </div>

            <p className="text-xs leading-5 text-white/35">{status.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
