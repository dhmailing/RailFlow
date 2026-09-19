"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, ShieldAlert, TestTube2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { stationNames } from "@/lib/rail/stations";
import type { JobStatus, ReservationJob, SeatClassPreference } from "@/lib/reservation/types";
import { toast } from "sonner";

const stations: string[] = [...stationNames];
const DEMO_USER_KEY = "railflow-demo-reservation-user";
const isDev = process.env.NODE_ENV !== "production";

type ProviderStatus = {
  scheduleProvider: "tago" | "mock";
  reservationProvider: "disabled" | "mock" | "official";
  reservationCapabilities: { simulation: boolean } | null;
  jobsEnabled: boolean;
  mockSimulationEnabled: boolean;
  allowLiveReservation: boolean;
};

const STATUS_LABEL: Record<JobStatus, string> = {
  DRAFT: "등록됨",
  SCHEDULED: "대기열 등록",
  WATCHING: "좌석 확인 중",
  RESERVING: "예약 시도 중",
  HELD: "좌석 확보",
  PAYMENT_PENDING: "결제 대기 (외부 채널)",
  COMPLETED: "완료",
  CANCELLED: "취소됨",
  EXPIRED: "만료됨",
  AUTH_REQUIRED: "인증 필요",
  RATE_LIMITED: "요청 제한됨",
  PROVIDER_CHANGED: "Provider 변경됨",
  FAILED: "실패",
};

function readOrCreateDemoUserId(): string {
  try {
    const saved = window.localStorage.getItem(DEMO_USER_KEY);
    if (saved) return saved;
    const created = `demo-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    window.localStorage.setItem(DEMO_USER_KEY, created);
    return created;
  } catch {
    return `demo-${Date.now()}`;
  }
}

export default function ReservationJobsPanel() {
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [jobs, setJobs] = useState<ReservationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [departure, setDeparture] = useState<string>(stations[0]);
  const [arrival, setArrival] = useState<string>(stations[1] ?? stations[0]);
  const [date, setDate] = useState("");
  const [timeRangeStart, setTimeRangeStart] = useState("09:00");
  const [timeRangeEnd, setTimeRangeEnd] = useState("18:00");
  const [passengers, setPassengers] = useState("1");
  const [seatClassPreference, setSeatClassPreference] = useState<SeatClassPreference>("standard_preferred");
  const [trainNumber, setTrainNumber] = useState("KTX 101");
  const [mockScenario, setMockScenario] = useState<"" | "seat_after_one_check" | "no_seat_ever" | "error_on_check" | "error_on_reserve">("seat_after_one_check");
  const [submitting, setSubmitting] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setUserId(readOrCreateDemoUserId());
      setDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() + 7 * 86_400_000)));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const refreshJobs = async (id: string) => {
    try {
      const response = await fetch(`/api/reservations?userId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = (await response.json()) as { jobs?: ReservationJob[]; error?: { message: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "작업 목록을 불러오지 못했습니다.");
      setJobs(payload.jobs ?? []);
    } catch {
      // provider-status already surfaces the disabled/error state; the job list can simply stay empty.
    }
  };

  useEffect(() => {
    if (!userId) return;
    // In production, every Demo reservation-job route (except provider-status
    // itself) fails closed server-side regardless of flags (see
    // lib/reservation/http.ts's isProductionEnvironment guard) -- so there is
    // no point calling them here, and the panel below shows the disabled
    // notice from `isDev` alone without waiting on a network round trip.
    if (!isDev) {
      const frame = window.requestAnimationFrame(() => setLoading(false));
      return () => window.cancelAnimationFrame(frame);
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/reservations/provider-status", { cache: "no-store" });
        const payload = (await response.json()) as ProviderStatus;
        if (!cancelled) setStatus(payload);
      } finally {
        if (!cancelled) setLoading(false);
      }
      await refreshJobs(userId);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const createJob = async () => {
    if (!userId || !date || departure === arrival) return;
    setSubmitting(true);
    try {
      const now = new Date();
      const departAt = `${date}T${timeRangeStart}:00+09:00`;
      const arriveAt = `${date}T${timeRangeEnd}:00+09:00`;
      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          departure,
          arrival,
          departureId: `demo-${stations.indexOf(departure)}`,
          arrivalId: `demo-${stations.indexOf(arrival)}`,
          date,
          timeRangeStart,
          timeRangeEnd,
          passengers,
          seatClassPreference,
          candidates: [
            {
              id: crypto.randomUUID(),
              trainNumber,
              departAt,
              arriveAt,
              ...(mockScenario ? { mockScenario } : {}),
            },
          ],
          expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
        }),
      });
      const payload = (await response.json()) as { job?: ReservationJob; error?: { message: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "자동예약 작업을 등록하지 못했습니다.");
      toast.success("Mock 자동예약 작업을 등록했어요", { description: "실제 예약이 아닌 서버 구조 검증용 작업입니다." });
      await refreshJobs(userId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "자동예약 작업을 등록하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelJob = async (id: string) => {
    setBusyJobId(id);
    try {
      const response = await fetch(`/api/reservations/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) throw new Error("취소하지 못했습니다.");
      await refreshJobs(userId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "취소하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  // simulationIntervalSeconds is required by the API (server-enforced via
  // assertSimulationAllowed on every call, not just when present) -- see
  // app/api/reservations/[id]/simulate/route.ts. There is no "run without a
  // verification value" path any more.
  const runStep = async (id: string, simulationIntervalSeconds: 1 | 2 | 3 | 4 | 5) => {
    setBusyJobId(id);
    try {
      const response = await fetch(`/api/reservations/${id}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          idempotencyKey: crypto.randomUUID(),
          simulationIntervalSeconds,
        }),
      });
      const payload = (await response.json()) as { job?: ReservationJob; error?: { message: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Worker 단계를 실행하지 못했습니다.");
      await refreshJobs(userId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Worker 단계를 실행하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  if (loading) {
    return (
      <div role="status" className="mt-8 rounded-2xl border border-white/10 p-6 text-sm text-white/50">
        <LoaderCircle className="mb-2 size-5 animate-spin text-orange-400" /> v0.4 예약 작업 기반 상태를 확인하는 중
      </div>
    );
  }

  return (
    <section className="mt-8 rounded-[24px] border border-dashed border-[#ff8a1f]/30 bg-[#0d0d0d]/80 p-5">
      <div className="mb-4 flex items-center gap-2">
        <TestTube2 className="size-5 text-[#ff9b3f]" />
        <h3 className="text-lg font-extrabold">Mock 자동예약 작업 (v0.4 서버 기반 미리보기)</h3>
        <span className="rounded-full bg-[#ff8a1f]/15 px-2 py-0.5 text-[11px] font-bold text-[#ffad62]">MOCK</span>
      </div>
      <p className="mb-4 flex items-start gap-2 text-sm leading-6 text-white/45">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[#ff9b3f]" />
        실제 코레일·SR 예약은 이루어지지 않습니다. 서버의 예약 작업 상태 전이·Queue·Worker 구조를 검증하기 위한 Mock Provider 결과만 표시됩니다.
      </p>

      {!isDev ? (
        <p className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/50">
          개발용 Mock 기능이며 실제 예약이 아닙니다. 사용자 인증 체계가 도입되기 전까지 이 기능은 운영 환경에서 항상 비활성화되어 있습니다.
        </p>
      ) : !status || status.reservationProvider === "disabled" || !status.jobsEnabled ? (
        <p className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/50">
          서버의 예약 작업 기능이 아직 비활성화 상태입니다 (RAIL_RESERVATION_PROVIDER / ENABLE_RESERVATION_JOBS). 운영 환경의 기본값은 항상 비활성화입니다.
        </p>
      ) : (
        <>
          <Card className="mb-5 rounded-2xl border-white/10 bg-black/30 py-0">
            <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
              <label className="text-sm text-white/55">
                출발역
                <select value={departure} onChange={(e) => setDeparture(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                  {stationNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="text-sm text-white/55">
                도착역
                <select value={arrival} onChange={(e) => setArrival(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                  {stationNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="text-sm text-white/55">
                출발일
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
              </label>
              <label className="text-sm text-white/55">
                인원
                <select value={passengers} onChange={(e) => setPassengers(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                  {[1, 2, 3, 4].map((count) => <option key={count} value={String(count)}>{count}명</option>)}
                </select>
              </label>
              <label className="text-sm text-white/55">
                희망 시간 시작
                <input type="time" value={timeRangeStart} onChange={(e) => setTimeRangeStart(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
              </label>
              <label className="text-sm text-white/55">
                희망 시간 종료
                <input type="time" value={timeRangeEnd} onChange={(e) => setTimeRangeEnd(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
              </label>
              <label className="text-sm text-white/55">
                객실 우선순위
                <select value={seatClassPreference} onChange={(e) => setSeatClassPreference(e.target.value as SeatClassPreference)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                  <option value="standard_only">일반실만</option>
                  <option value="standard_preferred">일반실 우선</option>
                  <option value="any">특실 허용</option>
                </select>
              </label>
              <label className="text-sm text-white/55">
                후보 열차 번호
                <input value={trainNumber} onChange={(e) => setTrainNumber(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white" />
              </label>
              {isDev && (
                <label className="text-sm text-white/55 sm:col-span-2">
                  Mock 시나리오 (개발용)
                  <select value={mockScenario} onChange={(e) => setMockScenario(e.target.value as typeof mockScenario)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                    <option value="seat_after_one_check">한 번 확인 후 좌석 발생</option>
                    <option value="no_seat_ever">좌석 없음 (계속 대기)</option>
                    <option value="error_on_check">확인 단계 오류</option>
                    <option value="error_on_reserve">예약 단계 오류</option>
                  </select>
                </label>
              )}
              <Button type="button" disabled={submitting || departure === arrival || !date} onClick={createJob} className="h-11 rounded-xl bg-[#ff8a1f] font-extrabold text-black hover:bg-[#ff9d45] sm:col-span-2">
                {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null} Mock 자동예약 작업 등록
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {jobs.length === 0 ? (
              <p className="text-sm text-white/40">등록된 Mock 작업이 없습니다.</p>
            ) : (
              jobs.map((job) => (
                <article key={job.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold">{job.departure} → {job.arrival} · {job.date}</p>
                      <p className="mt-1 text-xs text-white/45">
                        {job.timeRangeStart}~{job.timeRangeEnd} · 성인 {job.passengers}명 · 후보 {job.candidates.length}개
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {job.simulation && <span className="rounded-full bg-[#ff8a1f]/15 px-2 py-0.5 text-[10px] font-bold text-[#ffad62]">MOCK</span>}
                      <span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-bold text-white/70">{STATUS_LABEL[job.status]}</span>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-white/40">마지막 갱신 {new Date(job.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
                  {job.lastError && <p className="mt-1 text-xs text-orange-300">최근 오류: {job.lastError.message}</p>}
                  {!["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"].includes(job.status) && (
                    <div className="mt-3">
                      {status.mockSimulationEnabled && job.provider === "mock" && (
                        <p className="mb-2 text-[11px] text-white/35">
                          아래 버튼은 실제로 기다리거나 반복 실행되지 않습니다 — 선택한 검증값으로 Worker 한 단계만 즉시 실행합니다.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {status.mockSimulationEnabled && job.provider === "mock" &&
                          [1, 2, 3, 4, 5].map((seconds) => (
                            <Button key={seconds} size="sm" variant="outline" disabled={busyJobId === job.id} onClick={() => runStep(job.id, seconds as 1 | 2 | 3 | 4 | 5)} className="rounded-lg border-[#ff8a1f]/30 text-[#ffad62]">
                              <RefreshCw className="size-3.5" /> 검증값 {seconds} · 한 단계 실행
                            </Button>
                          ))}
                        <Button size="sm" variant="ghost" disabled={busyJobId === job.id} onClick={() => cancelJob(job.id)} className="rounded-lg text-white/50">
                          취소
                        </Button>
                      </div>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}
