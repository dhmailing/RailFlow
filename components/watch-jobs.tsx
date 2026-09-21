"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BellRing, Copy, ExternalLink, LoaderCircle, Plus, RefreshCw, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { stationNames } from "@/lib/rail/stations";
import type { AuthUser } from "@/components/auth-panel";

const stations: string[] = [...stationNames];
const isDev = process.env.NODE_ENV !== "production";

type JobStatus =
  | "REGISTERED" | "WATCHING" | "SEAT_FOUND" | "COMPLETED" | "CANCELLED" | "EXPIRED" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "FAILED";

type Device = {
  id: string;
  channel: "fcm" | "webpush" | "telegram" | "email";
  maskedDestination: string;
  verified: boolean;
  label: string | null;
};

type TrainCandidate = {
  id: string;
  externalKey: string;
  trainNumber: string;
  trainType: string;
  departAt: string;
  arriveAt: string;
  mockScenario?: string;
};

type WatchJob = {
  id: string;
  departure: string; arrival: string; date: string;
  timeRangeStart: string; timeRangeEnd: string; trainType: string; passengers: number;
  seatClassPreference: "standard_only" | "standard_preferred" | "any";
  candidates: TrainCandidate[];
  status: JobStatus;
  seatProvider: "unavailable" | "mock";
  simulation: boolean;
  foundCandidateId: string | null;
  createdAt: string; updatedAt: string; watchUntil: string;
  notificationMethods: Array<{ channel: string; deviceId: string }>;
};

type ProviderStatus = {
  seatAvailabilityProvider: "disabled" | "mock";
  jobsEnabled: boolean;
  watchStoreEnabled: boolean;
  mockSimulationEnabled: boolean;
};

const STATUS_LABEL: Record<JobStatus, string> = {
  REGISTERED: "등록됨", WATCHING: "감시 중", SEAT_FOUND: "좌석 발생",
  COMPLETED: "완료", CANCELLED: "취소됨", EXPIRED: "만료됨",
  PROVIDER_UNAVAILABLE: "Provider 미연결", RATE_LIMITED: "요청 제한됨", FAILED: "실패",
};

const CHANNEL_LABEL: Record<string, string> = { email: "이메일", telegram: "텔레그램", fcm: "푸시(FCM)", webpush: "웹 푸시" };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export default function WatchJobsPanel({ user }: { user: AuthUser | null }) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [jobs, setJobs] = useState<WatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | "unsupported">("default");

  const [departure, setDeparture] = useState<string>(stations[0]);
  const [arrival, setArrival] = useState<string>(stations[1] ?? stations[0]);
  const [date, setDate] = useState("");
  const [timeRangeStart, setTimeRangeStart] = useState("09:00");
  const [timeRangeEnd, setTimeRangeEnd] = useState("18:00");
  const [trainType, setTrainType] = useState("KTX");
  const [passengers, setPassengers] = useState("1");
  const [seatClassPreference, setSeatClassPreference] = useState<"standard_only" | "standard_preferred" | "any">("standard_preferred");
  const [watchHours, setWatchHours] = useState("6");
  const [candidateRows, setCandidateRows] = useState([{ trainNumber: "KTX 101", departAt: "10:00", arriveAt: "12:00", mockScenario: "seat_after_one_check" }]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [deviceChannel, setDeviceChannel] = useState<"email" | "telegram">("email");
  const [deviceToken, setDeviceToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() + 7 * 86_400_000)));
      if (typeof Notification === "undefined") setNotifyPermission("unsupported");
      else setNotifyPermission(Notification.permission);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const refreshAll = async () => {
    try {
      const [statusRes, deviceRes, jobRes] = await Promise.all([
        fetch("/api/watch-jobs/provider-status", { cache: "no-store" }),
        fetch("/api/devices", { cache: "no-store" }),
        fetch("/api/watch-jobs", { cache: "no-store" }),
      ]);
      if (statusRes.ok) setStatus(await readJson<ProviderStatus>(statusRes));
      if (deviceRes.ok) setDevices((await readJson<{ devices: Device[] }>(deviceRes)).devices);
      if (jobRes.ok) setJobs((await readJson<{ jobs: WatchJob[] }>(jobRes)).jobs);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the signed-in user changes
  }, [user?.id]);

  const requestNotificationPermission = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifyPermission(result);
  };

  const registerDevice = async () => {
    if (!deviceToken.trim()) return;
    try {
      const response = await fetch("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: deviceChannel, token: deviceToken.trim() }),
      });
      if (!response.ok) throw new Error("알림 수신 기기를 등록하지 못했습니다.");
      setDeviceToken("");
      await refreshAll();
      toast.success("알림 수신 기기를 등록했어요");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "등록하지 못했습니다.");
    }
  };

  const addCandidateRow = () => {
    if (candidateRows.length >= 3) return;
    setCandidateRows((rows) => [...rows, { trainNumber: `KTX ${100 + rows.length}`, departAt: "10:00", arriveAt: "12:00", mockScenario: "seat_after_one_check" }]);
  };

  const createJob = async () => {
    if (!date || departure === arrival || selectedDeviceIds.length === 0) {
      toast.error("역·날짜와 알림 받을 기기를 하나 이상 선택해주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const watchUntil = new Date(Date.now() + Number(watchHours) * 60 * 60 * 1000).toISOString();
      const candidates = candidateRows.map((row, index) => ({
        externalKey: crypto.randomUUID(),
        trainNumber: row.trainNumber,
        trainType,
        departAt: `${date}T${row.departAt}:00+09:00`,
        arriveAt: `${date}T${row.arriveAt}:00+09:00`,
        ...(isDev && row.mockScenario ? { mockScenario: row.mockScenario } : {}),
        _index: index,
      }));
      const response = await fetch("/api/watch-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          departure, arrival,
          departureId: `demo-${stations.indexOf(departure)}`,
          arrivalId: `demo-${stations.indexOf(arrival)}`,
          date, timeRangeStart, timeRangeEnd, trainType, passengers, seatClassPreference,
          candidates: candidates.map(({ _index, ...c }) => { void _index; return c; }),
          watchUntil,
          notificationMethods: selectedDeviceIds.map((deviceId) => ({
            deviceId,
            channel: devices.find((d) => d.id === deviceId)?.channel ?? "email",
          })),
        }),
      });
      const payload = await readJson<{ job?: WatchJob; error?: { message: string } }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? "감시 작업을 등록하지 못했습니다.");
      toast.success("취소표 감시를 등록했어요", { description: "실제 예매는 이루어지지 않으며, 좌석 발생 시 알림으로 안내합니다." });
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "감시 작업을 등록하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (path: string, method = "POST", body?: unknown) => {
    const response = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await readJson<{ job?: WatchJob; error?: { message: string } }>(response);
    if (!response.ok) throw new Error(payload.error?.message ?? "요청을 처리하지 못했습니다.");
    return payload.job;
  };

  const cancelJob = async (id: string) => {
    setBusyJobId(id);
    try {
      await act(`/api/watch-jobs/${id}/cancel`);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "취소하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const runTick = async (id: string, tick: 1 | 2 | 3 | 4 | 5) => {
    setBusyJobId(id);
    try {
      await act(`/api/watch-jobs/${id}/simulate`, "POST", { idempotencyKey: crypto.randomUUID(), tick });
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Worker 단계를 실행하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const confirmBooking = async (id: string) => {
    setBusyJobId(id);
    try {
      await act(`/api/watch-jobs/${id}/confirm-booking`);
      await refreshAll();
      toast.success("예매 완료로 기록했어요");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "처리하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const resumeWatching = async (id: string) => {
    setBusyJobId(id);
    try {
      await act(`/api/watch-jobs/${id}/resume`);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "처리하지 못했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  const openBooking = async (job: WatchJob) => {
    if (!job.foundCandidateId) return;
    try {
      const response = await fetch(`/api/watch-jobs/${job.id}/launch?candidateId=${encodeURIComponent(job.foundCandidateId)}`);
      const payload = await readJson<{ webFallbackUrl: string; copyText: string }>(response);
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(payload.copyText).catch(() => undefined);
        toast.success("조건을 복사했어요", { description: "코레일+에서 붙여넣기로 다시 검색해주세요." });
      }
      window.open(payload.webFallbackUrl, "_blank", "noopener,noreferrer");
    } catch {
      window.open("https://www.korail.com/", "_blank", "noopener,noreferrer");
    }
  };

  if (!user) {
    return (
      <section className="mx-auto max-w-3xl space-y-4">
        <div className="rounded-[28px] border border-white/[0.08] bg-[#0d0d0d]/80 p-6 text-center">
          <ShieldAlert className="mx-auto mb-3 size-8 text-white/25" />
          <h2 className="text-lg font-extrabold">로그인하면 취소표 감시를 등록할 수 있어요</h2>
          <p className="mt-2 text-sm text-white/40">마이페이지 탭에서 RailFlow 계정으로 로그인하거나 새로 만들어주세요.</p>
        </div>
        <Link
          href="/demo"
          className="flex items-center gap-3 rounded-2xl border border-[#ff8a1f]/25 bg-[#ff8a1f]/[0.06] p-4 text-left text-sm leading-6 text-white/60 transition hover:border-[#ff8a1f]/40"
        >
          <Sparkles className="mt-0.5 size-5 shrink-0 text-[#ff9b3f]" />
          <span>
            <span className="font-bold text-[#ffad62]">취소표 감시 가상 시연</span>
            <br />
            이 화면은 실제 취소표 감시를 등록하고, 이 링크는 로그인 없이 등록→감시→좌석 발견→알림 흐름만 눌러보는 가상 시연으로 이동합니다. 둘 다 실제 좌석 조회·예약·결제는 아닙니다.
          </span>
        </Link>
      </section>
    );
  }

  if (loading) {
    return (
      <div role="status" className="mx-auto max-w-3xl rounded-2xl border border-white/10 p-6 text-sm text-white/50">
        <LoaderCircle className="mb-2 size-5 animate-spin text-orange-400" /> 감시 작업을 불러오는 중
      </div>
    );
  }

  const providerUnavailable = !status || status.seatAvailabilityProvider === "disabled";
  // §1 검토사항: 운영 저장소(WATCH_STORE)가 연결되지 않은 상태에서는 새 기기
  // 등록·감시 작업 등록 폼 자체를 숨긴다 -- 서버가 어차피 503으로 거부하는
  // 폼을 보여주며 실제로 저장되는 것처럼 오해하게 만들지 않는다.
  const storeDisabled = !!status && !status.watchStoreEnabled;
  const watchingJobs = jobs.filter((j) => !["SEAT_FOUND", "COMPLETED", "CANCELLED", "EXPIRED", "FAILED"].includes(j.status));
  const seatFoundJobs = jobs.filter((j) => j.status === "SEAT_FOUND");

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-2xl border border-[#ff8a1f]/20 bg-[#ff8a1f]/[0.06] p-4 text-sm leading-6 text-white/60">
        <p className="font-bold text-[#ffad62]">RailFlow는 승차권을 판매하거나 결제하지 않습니다.</p>
        <p className="mt-1">실제 좌석과 결제 결과는 반드시 코레일+에서 최종 확인해주세요.</p>
        {providerUnavailable && (
          <p className="mt-1 flex items-center gap-1.5 text-orange-300"><ShieldAlert className="size-4" /> 공식 좌석 Provider가 아직 연결되지 않아 실시간 감시가 작동하지 않습니다.</p>
        )}
        {!status?.jobsEnabled && <p className="mt-1 text-white/40">감시 작업 기능이 서버에서 아직 활성화되지 않았습니다.</p>}
        {(providerUnavailable || !status?.jobsEnabled) && (
          <Link href="/demo" className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-bold text-[#ffad62] underline underline-offset-2">
            <Sparkles className="size-3.5" /> 취소표 감시 가상 시연 보기
          </Link>
        )}
      </div>

      {storeDisabled ? (
        <div className="rounded-2xl border border-white/10 bg-black/30 p-5 text-sm leading-6 text-white/50">
          <p className="font-bold text-white/70">감시 작업 등록 기능 준비 중</p>
          <p className="mt-1">운영 저장소가 아직 연결되지 않아 새 알림 수신처·감시 작업을 등록할 수 없습니다. 연결 후 다시 안내할게요.</p>
        </div>
      ) : (
      <>
      <Card className="rounded-2xl border-white/10 bg-black/30 py-0">
        <CardContent className="space-y-3 p-4">
          <p className="text-sm font-bold text-white/70">알림 받을 곳</p>
          <div className="flex flex-wrap gap-2">
            {devices.length === 0 && <p className="text-xs text-white/35">등록된 알림 수신처가 없습니다. 아래에서 하나를 추가해주세요.</p>}
            {devices.map((d) => (
              <label key={d.id} className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${selectedDeviceIds.includes(d.id) ? "border-[#ff8a1f] bg-[#ff8a1f]/15 text-[#ffad62]" : "border-white/10 text-white/50"}`}>
                <input type="checkbox" className="sr-only" checked={selectedDeviceIds.includes(d.id)} onChange={(e) => setSelectedDeviceIds((ids) => (e.target.checked ? [...ids, d.id] : ids.filter((id) => id !== d.id)))} />
                {CHANNEL_LABEL[d.channel]} · {d.maskedDestination}
                {!d.verified && <span className="text-white/30"> · 소유권 미확인</span>}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={deviceChannel} onChange={(e) => setDeviceChannel(e.target.value as "email" | "telegram")} className="rounded-lg border border-white/10 bg-[#111] p-2 text-sm text-white">
              <option value="email">이메일</option>
              <option value="telegram">텔레그램 chat id</option>
            </select>
            <input value={deviceToken} onChange={(e) => setDeviceToken(e.target.value)} placeholder={deviceChannel === "email" ? "you@example.com" : "텔레그램 chat id"} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#111] p-2 text-sm text-white" />
            <Button type="button" size="sm" onClick={registerDevice} className="rounded-lg bg-[#ff8a1f] text-black hover:bg-[#ff9d45]">추가</Button>
          </div>
          <p className="text-[11px] text-white/30">FCM 푸시·웹 푸시는 실제 서비스 키 연동 전까지 준비 중입니다.</p>
          {notifyPermission !== "unsupported" && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="flex items-center gap-2 text-xs text-white/50"><BellRing className="size-4 text-[#ff9b3f]" /> 브라우저 알림 권한: {notifyPermission === "granted" ? "허용됨" : notifyPermission === "denied" ? "거부됨" : "요청 전"}</p>
              {notifyPermission === "default" && <Button size="sm" variant="outline" onClick={requestNotificationPermission} className="rounded-lg border-white/10 text-white/60">권한 요청</Button>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-white/10 bg-black/30 py-0">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
          <p className="text-sm font-bold text-white/70 sm:col-span-2">감시 작업 등록</p>
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
          <label className="text-sm text-white/55">열차 종류
            <select value={trainType} onChange={(e) => setTrainType(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
              <option value="KTX">KTX</option><option value="SRT">SRT</option><option value="ITX">ITX</option><option value="무궁화">무궁화</option>
            </select>
          </label>
          <label className="text-sm text-white/55">희망 시간 시작
            <input type="time" value={timeRangeStart} onChange={(e) => setTimeRangeStart(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
          </label>
          <label className="text-sm text-white/55">희망 시간 종료
            <input type="time" value={timeRangeEnd} onChange={(e) => setTimeRangeEnd(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white [color-scheme:dark]" />
          </label>
          <label className="text-sm text-white/55">인원
            <select value={passengers} onChange={(e) => setPassengers(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
              {[1, 2, 3, 4].map((c) => <option key={c} value={String(c)}>{c}명</option>)}
            </select>
          </label>
          <label className="text-sm text-white/55">좌석 등급
            <select value={seatClassPreference} onChange={(e) => setSeatClassPreference(e.target.value as typeof seatClassPreference)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
              <option value="standard_only">일반실만</option>
              <option value="standard_preferred">일반실 우선, 없으면 특실 허용</option>
              <option value="any">특실 허용</option>
            </select>
          </label>
          <label className="text-sm text-white/55 sm:col-span-2">감시 종료시간
            <select value={watchHours} onChange={(e) => setWatchHours(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] p-2 text-white">
              <option value="1">1시간 후</option><option value="3">3시간 후</option><option value="6">6시간 후</option><option value="24">24시간 후</option><option value="72">72시간 후</option>
            </select>
          </label>

          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm text-white/55">후보 열차 (여러 열차 동시 선택 가능)</p>
              {candidateRows.length < 3 && <Button size="sm" variant="ghost" onClick={addCandidateRow} className="text-xs text-white/50"><Plus className="size-3.5" /> 후보 추가</Button>}
            </div>
            <div className="space-y-2">
              {candidateRows.map((row, index) => (
                <div key={index} className="grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-black/20 p-2">
                  <input value={row.trainNumber} onChange={(e) => setCandidateRows((rows) => rows.map((r, i) => (i === index ? { ...r, trainNumber: e.target.value } : r)))} placeholder="열차번호" className="rounded-lg border border-white/10 bg-[#111] p-2 text-xs text-white" />
                  <input type="time" value={row.departAt} onChange={(e) => setCandidateRows((rows) => rows.map((r, i) => (i === index ? { ...r, departAt: e.target.value } : r)))} className="rounded-lg border border-white/10 bg-[#111] p-2 text-xs text-white [color-scheme:dark]" />
                  <input type="time" value={row.arriveAt} onChange={(e) => setCandidateRows((rows) => rows.map((r, i) => (i === index ? { ...r, arriveAt: e.target.value } : r)))} className="rounded-lg border border-white/10 bg-[#111] p-2 text-xs text-white [color-scheme:dark]" />
                  {isDev && (
                    <select value={row.mockScenario} onChange={(e) => setCandidateRows((rows) => rows.map((r, i) => (i === index ? { ...r, mockScenario: e.target.value } : r)))} className="col-span-3 rounded-lg border border-white/10 bg-[#111] p-2 text-xs text-white">
                      <option value="seat_after_one_check">Mock: 한 번 확인 후 좌석 발생</option>
                      <option value="no_seat_ever">Mock: 좌석 없음(계속 대기)</option>
                      <option value="error_on_check">Mock: 확인 단계 오류</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Button type="button" disabled={submitting || departure === arrival || !date} onClick={createJob} className="h-11 rounded-xl bg-[#ff8a1f] font-extrabold text-black hover:bg-[#ff9d45] sm:col-span-2">
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null} 취소표 감시 등록
          </Button>
        </CardContent>
      </Card>
      </>
      )}

      <div>
        <p className="mb-2 px-1 text-sm font-bold text-white/60">진행 중인 감시 {watchingJobs.length > 0 && `· ${watchingJobs.length}건`}</p>
        {watchingJobs.length === 0 ? (
          <p className="px-1 text-sm text-white/35">진행 중인 감시가 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {watchingJobs.map((job) => (
              <article key={job.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold">{job.departure} → {job.arrival} · {job.date}</p>
                    <p className="mt-1 text-xs text-white/45">후보 {job.candidates.length}개 · 마지막 갱신 {new Date(job.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {job.simulation && <span className="rounded-full bg-[#ff8a1f]/15 px-2 py-0.5 text-[10px] font-bold text-[#ffad62]">MOCK</span>}
                    <span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-bold text-white/70">{STATUS_LABEL[job.status]}</span>
                  </div>
                </div>
                <p className="mt-2 text-xs text-white/35">Provider: {job.seatProvider === "mock" ? "Mock(테스트)" : "미연결"} · 다음 확인: 서버 백그라운드 스케줄러 미구현(개발 환경 검증값 버튼 사용) · 종료 {new Date(job.watchUntil).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {status?.mockSimulationEnabled && job.simulation && [1, 2, 3, 4, 5].map((tick) => (
                    <Button key={tick} size="sm" variant="outline" disabled={busyJobId === job.id} onClick={() => runTick(job.id, tick as 1 | 2 | 3 | 4 | 5)} className="rounded-lg border-[#ff8a1f]/30 text-[#ffad62]">
                      <RefreshCw className="size-3.5" /> 검증값 {tick}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" disabled={busyJobId === job.id} onClick={() => cancelJob(job.id)} className="rounded-lg text-white/50"><Trash2 className="size-3.5" /> 취소</Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {seatFoundJobs.length > 0 && (
        <div>
          <p className="mb-2 px-1 text-sm font-bold text-emerald-300">좌석 발생</p>
          <div className="space-y-3">
            {seatFoundJobs.map((job) => {
              const candidate = job.candidates.find((c) => c.id === job.foundCandidateId);
              return (
                <article key={job.id} className="overflow-hidden rounded-[22px] border border-emerald-400/25 bg-emerald-400/[0.06]">
                  <div className="p-4">
                    <p className="text-sm font-bold text-emerald-300">{job.departure} → {job.arrival} · {job.date}</p>
                    {candidate && <p className="mt-1 text-xs text-white/50">{candidate.trainNumber} · {candidate.departAt.slice(11, 16)} 출발 → {candidate.arriveAt.slice(11, 16)} 도착 · {job.seatClassPreference === "any" ? "특실 허용" : "일반실"}</p>}
                    <p className="mt-1 text-xs text-white/35">감지 {job.updatedAt && new Date(job.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Button size="sm" onClick={() => openBooking(job)} className="rounded-xl bg-emerald-400 text-black hover:bg-emerald-300"><Copy className="size-3.5" /> 코레일+에서 예매하기 <ExternalLink className="size-3.5" /></Button>
                      <Button size="sm" variant="outline" disabled={busyJobId === job.id} onClick={() => confirmBooking(job.id)} className="rounded-xl border-emerald-400/40 text-emerald-300">예매 완료</Button>
                      <Button size="sm" variant="ghost" disabled={busyJobId === job.id} onClick={() => resumeWatching(job.id)} className="rounded-xl text-white/50">다시 감시</Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
