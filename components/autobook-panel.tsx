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
import { CircleCheck, CircleDashed, Server, ShieldQuestion } from "lucide-react";
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
            <div className="space-y-2 rounded-2xl border border-white/10 bg-black/25 p-3">
              <p className="flex items-start gap-2 text-sm font-bold text-white/80">
                <Server className="mt-0.5 size-4 shrink-0" />
                지금 준비된 것
              </p>
              <ul className="space-y-1">
                <Ready ok>작업 상태 기계 · 중복 방지 · 분산 락 · 멱등키</Ready>
                <Ready ok>Queue · 독립 Worker · 알림 Outbox · 감사 기록</Ready>
                <Ready ok>운영자 차단·요청 제한·결과 불명확 처리</Ready>
                <Ready ok={status.provider.capabilities.canReadAvailability}>
                  실제 좌석 상태 조회 {status.provider.capabilities.canReadAvailability ? "" : "— 승인된 연동 없음"}
                </Ready>
                <Ready ok={status.provider.capabilities.canCreateReservation}>
                  실제 좌석 확보(예약) {status.provider.capabilities.canCreateReservation ? "" : "— 승인된 연동 없음"}
                </Ready>
                <Ready ok={status.runtime.storeUsable}>
                  영속 저장소 {status.runtime.storeUsable ? "" : `— 현재 ${status.runtime.store}`}
                </Ready>
              </ul>
              <p className="text-xs leading-5 text-white/35">
                현재 Provider: <span className="font-mono">{status.provider.name}</span>
                {status.provider.capabilities.simulation && " (시뮬레이션 — 실제 좌석이 아닙니다)"}
              </p>
            </div>

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

            <p className="text-xs leading-5 text-white/35">{status.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
