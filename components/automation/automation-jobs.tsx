"use client";

// v0.7 "자동 좌석조회·예약 매크로" 진행 중 작업 패널(§5 UI). 이 컴포넌트는
// /api/automation-jobs/**와 /api/automation/mock-site/listings만 호출한다 --
// 실제 코레일/SR API는 절대 호출하지 않는다. 실제 자동화(브라우저 클릭)는
// 이 화면이 아니라 서버(lib/automation/worker.ts)에서 /api/automation-jobs/
// [id]/run-step을 통해 일어난다 -- 이 화면은 그 결과를 보여주고, 설정한
// 간격(1~5초)마다 그 엔드포인트를 호출해 다음 단계를 트리거할 뿐이다.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BellRing, LoaderCircle, RefreshCw, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { stationNames } from "@/lib/rail/stations";
import type { AuthUser } from "@/components/auth-panel";

type JobStatus =
  | "SCHEDULED" | "WATCHING" | "CHECKING_AVAILABILITY" | "SEAT_FOUND" | "PURCHASE_CLICKING" | "RESERVING"
  | "HELD" | "PAYMENT_PENDING" | "SOLD_OUT" | "RATE_LIMITED" | "AUTH_REQUIRED" | "PROVIDER_CHANGED"
  | "FAILED" | "CANCELLED" | "EXPIRED" | "PAYMENT_EXPIRED" | "COMPLETED";

type Candidate = { id: string; trainNumber: string; trainType: string; departAt: string; arriveAt: string; fareLabel: string };

type AutomationJob = {
  id: string;
  departure: string; arrival: string; date: string;
  timeRangeStart: string; timeRangeEnd: string; passengers: number;
  seatClassPreference: "standard_only" | "standard_preferred" | "any";
  candidates: Candidate[];
  watchUntil: string;
  intervalSeconds: number;
  status: JobStatus;
  provider: string;
  simulation: boolean;
  watchCycle: number;
  attempts: number;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  heldCandidateId: string | null;
  reservationNumber: string | null;
  paymentDeadline: string | null;
  lastError: { code: string; message: string } | null;
};

type ProviderStatus = {
  seatAutomationProvider: "unavailable" | "mock-browser" | "official";
  jobsEnabled: boolean;
  mockBookingSiteEnabled: boolean;
  realProductionEnvironment: boolean;
};

type Listing = { id: string; trainNumber: string; trainType: string; departAt: string; arriveAt: string; fareLabel: string };

const STATUS_LABEL: Record<JobStatus, string> = {
  SCHEDULED: "예약됨", WATCHING: "감시 중", CHECKING_AVAILABILITY: "좌석 확인 중", SEAT_FOUND: "좌석 발견",
  PURCHASE_CLICKING: "구매 클릭 중", RESERVING: "예약 요청 중", HELD: "좌석 확보", PAYMENT_PENDING: "결제 대기",
  SOLD_OUT: "매진(재판매 없음)", RATE_LIMITED: "요청 제한됨", AUTH_REQUIRED: "인증 필요", PROVIDER_CHANGED: "Provider 변경됨",
  FAILED: "실패", CANCELLED: "취소됨", EXPIRED: "만료됨", PAYMENT_EXPIRED: "결제기한 만료", COMPLETED: "완료",
};

const ACTIVE_STATUSES: readonly JobStatus[] = ["SCHEDULED", "WATCHING", "CHECKING_AVAILABILITY", "SEAT_FOUND", "PURCHASE_CLICKING", "RESERVING", "RATE_LIMITED", "AUTH_REQUIRED"];
const TERMINAL_STATUSES: readonly JobStatus[] = ["SOLD_OUT", "CANCELLED", "EXPIRED", "FAILED", "COMPLETED"];

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export default function AutomationJobsPanel({ user }: { user: AuthUser | null }) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [departure, setDeparture] = useState<string>(stationNames[0]);
  const [arrival, setArrival] = useState<string>(stationNames[1] ?? stationNames[0]);
  const [date, setDate] = useState("");
  const [timeRangeStart, setTimeRangeStart] = useState("05:00");
  const [timeRangeEnd, setTimeRangeEnd] = useState("10:00");
  const [passengers, setPassengers] = useState("1");
  const [seatClassPreference, setSeatClassPreference] = useState<"standard_only" | "standard_preferred" | "any">("standard_preferred");
  const [selectedListingIds, setSelectedListingIds] = useState<string[]>([]);
  const [intervalSeconds, setIntervalSeconds] = useState(2);
  const [watchHours, setWatchHours] = useState("1");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() + 86_400_000)));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const refreshAll = async () => {
    try {
      const [statusRes, listingsRes, jobsRes] = await Promise.all([
        fetch("/api/automation-jobs/provider-status", { cache: "no-store" }),
        fetch("/api/automation/mock-site/listings", { cache: "no-store" }),
        fetch("/api/automation-jobs", { cache: "no-store" }),
      ]);
      if (statusRes.ok) setStatus(await readJson<ProviderStatus>(statusRes));
      if (listingsRes.ok) setListings((await readJson<{ listings: Listing[] }>(listingsRes)).listings);
      if (jobsRes.ok) setJobs((await readJson<{ jobs: AutomationJob[] }>(jobsRes)).jobs);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) {
      const frame = window.requestAnimationFrame(() => setLoading(false));
      return () => window.cancelAnimationFrame(frame);
    }
    const frame = window.requestAnimationFrame(() => {
      setLoading(true);
      void refreshAll();
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // "다음 조회까지 남은 시간" 표시용 화면 갱신 시계. FSM/폴링 타이머는
  // 전혀 건드리지 않는 별도의 setInterval이다(v0.6 Demo Showcase와 동일한
  // 이유로 렌더 중 Date.now()를 직접 호출하지 않는다).
  useEffect(() => {
    if (jobs.every((job) => !ACTIVE_STATUSES.includes(job.status))) return undefined;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [jobs]);

  // 설정한 간격(1~5초)마다 각 활성 작업의 run-step을 한 번씩 호출한다(§C).
  // 작업당 타이머 1개만 유지하고, 상태가 바뀌거나 unmount되면 항상 먼저
  // 정리한다 -- v0.6 Demo Showcase의 단일 슬롯 타이머와 동일한 이유.
  useEffect(() => {
    const timers = timersRef.current;
    for (const job of jobs) {
      const shouldPoll = ACTIVE_STATUSES.includes(job.status);
      const existing = timers.get(job.id);
      if (!shouldPoll) {
        if (existing) {
          clearTimeout(existing);
          timers.delete(job.id);
        }
        continue;
      }
      if (existing) continue; // 이미 예약된 타이머가 있으면 중복 예약하지 않는다.
      const handle = setTimeout(async () => {
        timers.delete(job.id);
        try {
          const response = await fetch(`/api/automation-jobs/${job.id}/run-step`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
          });
          if (response.ok) {
            const payload = await readJson<{ job: AutomationJob }>(response);
            setJobs((current) => current.map((j) => (j.id === payload.job.id ? payload.job : j)));
          }
        } catch {
          // 다음 폴링에서 다시 시도한다.
        }
      }, job.intervalSeconds * 1000);
      timers.set(job.id, handle);
    }
    // 목록에서 사라진 작업의 타이머는 정리한다.
    for (const [jobId, handle] of timers) {
      if (!jobs.some((j) => j.id === jobId)) {
        clearTimeout(handle);
        timers.delete(jobId);
      }
    }
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, [jobs]);

  const toggleListing = (id: string) => {
    setSelectedListingIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const createJob = async () => {
    if (!date || departure === arrival || selectedListingIds.length === 0) {
      toast.error("역·날짜와 후보 열차를 하나 이상 선택해주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const candidates = listings.filter((l) => selectedListingIds.includes(l.id));
      const watchUntil = new Date(Date.now() + Number(watchHours) * 60 * 60 * 1000).toISOString();
      const response = await fetch("/api/automation-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ departure, arrival, date, timeRangeStart, timeRangeEnd, passengers, seatClassPreference, candidates, watchUntil, intervalSeconds }),
      });
      const payload = await readJson<{ job?: AutomationJob; error?: { message: string } }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? "작업을 등록하지 못했습니다.");
      toast.success("자동 좌석조회·예약 매크로를 등록했어요", { description: "설정한 간격마다 Mock 예매 사이트를 자동으로 확인합니다." });
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "작업을 등록하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (path: string) => {
    const response = await fetch(path, { method: "POST" });
    const payload = await readJson<{ job?: AutomationJob; error?: { message: string } }>(response);
    if (!response.ok) throw new Error(payload.error?.message ?? "요청을 처리하지 못했습니다.");
    if (payload.job) setJobs((current) => current.map((j) => (j.id === payload.job!.id ? payload.job! : j)));
  };

  const cancelJob = async (id: string) => {
    setBusyJobId(id);
    try {
      await act(`/api/automation-jobs/${id}/cancel`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "중지하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const resumeJob = async (id: string) => {
    setBusyJobId(id);
    try {
      await act(`/api/automation-jobs/${id}/resume`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "다시 감시하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const confirmPayment = async (id: string) => {
    setBusyJobId(id);
    try {
      await act(`/api/automation-jobs/${id}/confirm-payment`);
      toast.success("결제 완료로 기록했어요");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "처리하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const deleteJob = async (id: string) => {
    setBusyJobId(id);
    try {
      const response = await fetch(`/api/automation-jobs/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("삭제하지 못했습니다.");
      setJobs((current) => current.filter((j) => j.id !== id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "삭제하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  if (!user) {
    return (
      <section className="mx-auto max-w-3xl rounded-[28px] border border-white/[0.08] bg-[#0d0d0d]/80 p-6 text-center">
        <ShieldAlert className="mx-auto mb-3 size-8 text-white/25" />
        <h2 className="text-lg font-extrabold">로그인하면 자동 좌석조회·예약 매크로를 등록할 수 있어요</h2>
        <p className="mt-2 text-sm text-white/40">마이페이지 탭에서 RailFlow 계정으로 로그인해주세요.</p>
      </section>
    );
  }

  if (loading) {
    return (
      <div role="status" className="mx-auto max-w-3xl rounded-2xl border border-white/10 p-6 text-sm text-white/50">
        <LoaderCircle className="mb-2 size-5 animate-spin text-orange-400" /> 자동화 작업을 불러오는 중
      </div>
    );
  }

  const disabled = !status?.jobsEnabled || status.realProductionEnvironment;
  const successJobs = jobs.filter((j) => j.status === "HELD" || j.status === "PAYMENT_PENDING" || j.status === "COMPLETED");
  const otherJobs = jobs.filter((j) => !successJobs.includes(j));

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-2xl border border-[#ff8a1f]/20 bg-[#ff8a1f]/[0.06] p-4 text-sm leading-6 text-white/60">
        <p className="font-bold text-[#ffad62]">자동 좌석조회·예약 매크로(Mock 시뮬레이터)</p>
        <p className="mt-1">RailFlow가 관리하는 Mock 예매 사이트(/demo/booking-simulator)에서만 실제 브라우저 자동화가 동작합니다. 실제 코레일·SR 사이트는 절대 접근하지 않습니다.</p>
        {status?.realProductionEnvironment && (
          <p className="mt-1 flex items-center gap-1.5 text-orange-300"><ShieldAlert className="size-4" /> 운영(Production) 환경에서는 이 기능이 항상 비활성화되어 있습니다.</p>
        )}
        {!status?.jobsEnabled && !status?.realProductionEnvironment && <p className="mt-1 text-white/40">서버에서 아직 활성화되지 않았습니다.</p>}
        <Link href="/demo/booking-simulator" className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-bold text-[#ffad62] underline underline-offset-2">
          <Sparkles className="size-3.5" /> Mock 예매 사이트 직접 열어보기
        </Link>
      </div>

      {!disabled && (
        <Card className="rounded-2xl border-white/10 bg-black/30 py-0">
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
            <p className="text-sm font-bold text-white/70 sm:col-span-2">자동화 작업 등록</p>
            <label className="text-sm text-white/55">출발역
              <select value={departure} onChange={(e) => setDeparture(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                {stationNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="text-sm text-white/55">도착역
              <select value={arrival} onChange={(e) => setArrival(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                {stationNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="text-sm text-white/55">출발일
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
            </label>
            <label className="text-sm text-white/55">인원
              <select value={passengers} onChange={(e) => setPassengers(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                {[1, 2, 3, 4].map((c) => <option key={c} value={String(c)}>{c}명</option>)}
              </select>
            </label>
            <label className="text-sm text-white/55">희망 출발시간 시작
              <input type="time" value={timeRangeStart} onChange={(e) => setTimeRangeStart(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
            </label>
            <label className="text-sm text-white/55">희망 출발시간 종료
              <input type="time" value={timeRangeEnd} onChange={(e) => setTimeRangeEnd(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
            </label>
            <label className="text-sm text-white/55 sm:col-span-2">좌석 등급
              <select value={seatClassPreference} onChange={(e) => setSeatClassPreference(e.target.value as typeof seatClassPreference)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                <option value="standard_only">일반실만</option>
                <option value="standard_preferred">일반실 우선, 없으면 특실 허용</option>
                <option value="any">특실 허용</option>
              </select>
            </label>

            <div className="sm:col-span-2">
              <p className="mb-2 text-sm text-white/55">후보 열차(Mock 예매 사이트, 복수 선택 가능)</p>
              <div className="space-y-2">
                {listings.map((listing) => (
                  <label key={listing.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-2">
                    <input type="checkbox" checked={selectedListingIds.includes(listing.id)} onChange={() => toggleListing(listing.id)} className="size-5 accent-[#ff8a1f]" />
                    <span className="text-sm text-white/70">{listing.trainType} {listing.trainNumber} · {listing.departAt}→{listing.arriveAt} · {listing.fareLabel}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="text-sm text-white/55">실행 간격
              <select value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>{s}초</option>)}
              </select>
            </label>
            <label className="text-sm text-white/55">감시 만료시각
              <select value={watchHours} onChange={(e) => setWatchHours(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
                <option value="1">1시간 후</option><option value="3">3시간 후</option><option value="6">6시간 후</option><option value="24">24시간 후</option>
              </select>
            </label>
            <p className="text-[11px] leading-5 text-white/32 sm:col-span-2">이 간격은 RailFlow 자체 Mock 예매 사이트를 확인하는 속도일 뿐이며 실제 철도 서버 조회 주기가 아닙니다.</p>

            <Button type="button" disabled={submitting || departure === arrival || !date || selectedListingIds.length === 0} onClick={createJob} className="h-11 rounded-xl bg-[#ff8a1f] font-extrabold text-black hover:bg-[#ff9d45] sm:col-span-2">
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null} 자동 감시 시작
            </Button>
          </CardContent>
        </Card>
      )}

      {successJobs.length > 0 && (
        <div>
          <p className="mb-2 px-1 text-sm font-bold text-emerald-300">예약 성공</p>
          <div className="space-y-3">
            {successJobs.map((job) => {
              const heldCandidate = job.candidates.find((c) => c.id === job.heldCandidateId);
              return (
                <article key={job.id} className="overflow-hidden rounded-[22px] border border-emerald-400/25 bg-emerald-400/[0.08] p-4">
                  <p className="text-sm font-bold text-emerald-300">예약 성공</p>
                  {heldCandidate && <p className="mt-1 text-base font-extrabold">{heldCandidate.trainType} {heldCandidate.trainNumber}</p>}
                  {heldCandidate && <p className="text-sm text-white/60">{job.departure} {heldCandidate.departAt} → {job.arrival} {heldCandidate.arriveAt}</p>}
                  <p className="mt-2 text-sm text-white/70">가상 예약번호: {job.reservationNumber}</p>
                  {job.paymentDeadline && (
                    <p className="text-sm text-white/70">결제기한: {new Date(job.paymentDeadline).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}</p>
                  )}
                  <div className="mt-2 space-y-1">
                    {job.candidates.filter((c) => c.id !== job.heldCandidateId).map((c) => (
                      <p key={c.id} className="text-xs text-white/35">{c.trainNumber}: 다른 열차 예약 성공으로 자동 중단</p>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {job.status === "PAYMENT_PENDING" && (
                      <Button size="sm" disabled={busyJobId === job.id} onClick={() => confirmPayment(job.id)} className="rounded-lg bg-emerald-400 text-black hover:bg-emerald-300">결제 완료</Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busyJobId === job.id} onClick={() => deleteJob(job.id)} className="rounded-lg text-white/50"><Trash2 className="size-3.5" /> 삭제</Button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 px-1 text-sm font-bold text-white/60">진행 중인 작업 {otherJobs.length > 0 && `· ${otherJobs.length}건`}</p>
        {otherJobs.length === 0 ? (
          <p className="px-1 text-sm text-white/35">진행 중인 자동화 작업이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {otherJobs.map((job) => {
              const isTerminal = TERMINAL_STATUSES.includes(job.status);
              const nextIn = job.nextCheckAt ? Math.max(0, Math.round((new Date(job.nextCheckAt).getTime() - nowTick) / 1000)) : null;
              return (
                <article key={job.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold">{job.departure} → {job.arrival} · {job.date}</p>
                      <p className="mt-1 text-xs text-white/45">후보 {job.candidates.map((c) => c.trainNumber).join(", ")}</p>
                    </div>
                    <span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-bold text-white/70">{STATUS_LABEL[job.status]}</span>
                  </div>
                  <p className="mt-2 text-xs text-white/35">
                    시도 {job.attempts}회 · 최근 조회 {job.lastCheckedAt ? new Date(job.lastCheckedAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "-"}
                    {nextIn !== null && !isTerminal && ` · 다음 조회까지 ${nextIn}초`}
                  </p>
                  {job.lastError && <p className="mt-1 flex items-center gap-1 text-xs text-orange-300"><BellRing className="size-3" /> {job.lastError.message}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!isTerminal && (
                      <Button size="sm" variant="ghost" disabled={busyJobId === job.id} onClick={() => cancelJob(job.id)} className="rounded-lg text-white/50">감시 중지</Button>
                    )}
                    {job.status === "PAYMENT_EXPIRED" && (
                      <Button size="sm" variant="outline" disabled={busyJobId === job.id} onClick={() => resumeJob(job.id)} className="rounded-lg border-[#ff8a1f]/30 text-[#ffad62]"><RefreshCw className="size-3.5" /> 다시 감시</Button>
                    )}
                    {isTerminal && (
                      <Button size="sm" variant="ghost" disabled={busyJobId === job.id} onClick={() => deleteJob(job.id)} className="rounded-lg text-white/50"><Trash2 className="size-3.5" /> 작업 삭제</Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
