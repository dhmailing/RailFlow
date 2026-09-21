"use client";

// RailFlow v0.6 "Demo Showcase" (/demo). Fully client-only: every byte of
// state lives in this tab's sessionStorage, driven by the pure reducer in
// lib/demo/reducer.ts and a single-slot timer (lib/demo/timer.ts). This
// component never calls /api/auth/**, /api/watch-jobs/**,
// /api/reservations/**, or any real railway/notification API -- see
// lib/demo/types.ts's header comment for the full module-boundary rule.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftRight,
  BellRing,
  CalendarDays,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  Hourglass,
  RefreshCcw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  SquareX,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { OFFICIAL_BOOKING_URL } from "@/lib/demo/scenarios";
import { createDefaultDemoState, demoReducer, type DemoAction } from "@/lib/demo/reducer";
import { createDemoTimerController } from "@/lib/demo/timer";
import { clearDemoState, readDemoState, writeDemoState } from "@/lib/demo/storage";
import type { DemoCandidate, DemoIntervalSeconds, DemoStatus } from "@/lib/demo/types";

const STATUS_LABEL: Record<DemoStatus, string> = {
  READY: "조건 설정",
  REGISTERED: "가상 감시 등록됨",
  WATCHING: "가상 감시 중",
  SEAT_FOUND: "좌석 발견",
  NOTIFIED: "가상 알림 표시됨",
  FINISHED: "시연 종료",
  CANCELLED: "시연 중단됨",
};

const CANDIDATE_STATUS_LABEL: Record<"idle" | "watching" | "seat_found" | "stopped", string> = {
  idle: "확인 필요",
  watching: "감시 중",
  seat_found: "좌석 발견",
  stopped: "감시 중단",
};

const INTERVAL_OPTIONS: DemoIntervalSeconds[] = [1, 2, 3, 4, 5];
const ACTIVE_STATUSES: readonly DemoStatus[] = ["REGISTERED", "WATCHING", "SEAT_FOUND", "NOTIFIED"];

function reducerWithHydrate(state: ReturnType<typeof createDefaultDemoState>, action: DemoAction | { type: "HYDRATE"; state: ReturnType<typeof createDefaultDemoState> }) {
  if (action.type === "HYDRATE") return action.state;
  return demoReducer(state, action);
}

export default function DemoShowcase() {
  const [state, dispatch] = useReducer(reducerWithHydrate, undefined, createDefaultDemoState);
  const [hydrated, setHydrated] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const timerRef = useRef(createDemoTimerController());
  const notifiedOnceRef = useRef<string | null>(null);

  // sessionStorage 복원 (§9) -- app/page.tsx의 storageReady 패턴과 동일하게,
  // 마운트 이후 한 프레임을 기다려 복원한다.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = readDemoState(window.sessionStorage);
      if (saved) dispatch({ type: "HYDRATE", state: saved });
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeDemoState(window.sessionStorage, state);
  }, [state, hydrated]);

  // 유일한 자동 전이 타이머 -- 단일 슬롯 컨트롤러 하나만 사용하므로 어떤
  // 시점에도 대기 중인 타이머는 최대 1개다(§6, §14). status/intervalSeconds/
  // watchTick이 바뀔 때마다 이전 타이머는 반드시 먼저 정리된다.
  useEffect(() => {
    const controller = timerRef.current;
    const delayMs = state.intervalSeconds * 1000;
    if (state.status === "REGISTERED") {
      controller.schedule(() => dispatch({ type: "START_WATCHING" }), delayMs);
    } else if (state.status === "WATCHING") {
      controller.schedule(() => dispatch({ type: "TICK" }), delayMs);
    } else if (state.status === "SEAT_FOUND") {
      controller.schedule(() => dispatch({ type: "MARK_NOTIFIED" }), delayMs);
    } else {
      controller.clear();
    }
    return () => controller.clear();
  }, [state.status, state.intervalSeconds, state.watchTick]);

  // NOTIFIED 진입 시 1회 토스트+진동(§7). notifiedOnceRef로 같은 알림 id에
  // 대해 중복 실행을 막는다.
  useEffect(() => {
    if (state.status !== "NOTIFIED") return;
    const last = state.notifications[state.notifications.length - 1];
    if (!last || notifiedOnceRef.current === last.id) return;
    notifiedOnceRef.current = last.id;
    toast.success(last.title, { description: last.body });
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(150);
      } catch {
        // 진동 미지원/거부 -- 무시
      }
    }
  }, [state.status, state.notifications]);

  // 화면 표시용 경과시간 시계. FSM을 전혀 건드리지 않는 별도의 setInterval이며,
  // 활성 상태가 아니면 즉시 정리된다.
  useEffect(() => {
    if (!ACTIVE_STATUSES.includes(state.status)) return undefined;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.status]);

  const elapsedSeconds = useMemo(() => {
    if (!ACTIVE_STATUSES.includes(state.status)) return 0;
    return Math.max(0, Math.floor((nowTick - new Date(state.createdAt).getTime()) / 1000));
  }, [nowTick, state.createdAt, state.status]);

  const resetDemo = () => {
    timerRef.current.clear();
    clearDemoState(window.sessionStorage);
    notifiedOnceRef.current = null;
    dispatch({ type: "HYDRATE", state: createDefaultDemoState() });
    toast("데모를 초기화했어요");
  };

  const isReady = state.status === "READY";
  const seatFoundCandidate = state.candidates.find((candidate) => candidate.id === state.foundCandidateId) ?? null;
  const showHighlight = state.status === "SEAT_FOUND" || state.status === "NOTIFIED";

  return (
    <main className="min-h-dvh bg-[#070707] text-white">
      <div className="mx-auto min-h-dvh max-w-3xl border-x border-white/[0.06] bg-[radial-gradient(circle_at_50%_-12%,rgba(255,137,31,0.15),transparent_34%)] pb-16">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#070707]/95 backdrop-blur-xl">
          <div className="flex items-center justify-between px-4 py-3 sm:px-6">
            <Link href="/" className="text-sm font-bold text-white/60 hover:text-white">
              ← RailFlow로 돌아가기
            </Link>
            <Button size="sm" variant="ghost" onClick={resetDemo} className="rounded-lg text-xs text-white/50 hover:text-white">
              <RotateCcw className="size-3.5" /> 데모 초기화
            </Button>
          </div>
          <div className="flex items-center gap-2 border-t border-white/[0.06] bg-[#ff8a1f]/[0.08] px-4 py-2.5 text-xs font-bold text-[#ffad62] sm:px-6">
            <Sparkles className="size-4 shrink-0" />
            가상 시연 · 실제 좌석 조회 및 예약이 아닙니다
          </div>
        </header>

        <div className="space-y-5 px-4 pt-5 sm:px-6">
          <div>
            <p className="text-sm font-semibold text-[#ff9b3f]">Demo Showcase</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-[-0.03em]">취소표 감시 · 알림 가상 시연</h1>
            <p className="mt-2 text-sm leading-6 text-white/45">
              실제 코레일/SR/TAGO 서버와 통신하지 않는 브라우저 전용 시연입니다. 아래 흐름을 눌러보며 등록부터 좌석 발견,
              공식 예매 안내까지 전체 과정을 확인할 수 있어요.
            </p>
          </div>

          <p aria-live="polite" role="status" className="sr-only">
            현재 상태: {STATUS_LABEL[state.status]}
          </p>

          <SearchConditionCard state={state} dispatch={dispatch} disabled={!isReady} />

          <CandidateListCard state={state} dispatch={dispatch} disabled={!isReady} />

          <IntervalCard intervalSeconds={state.intervalSeconds} dispatch={dispatch} />

          {isReady && (
            <Button
              type="button"
              disabled={state.selectedCandidateIds.length === 0}
              onClick={() => dispatch({ type: "REGISTER" })}
              className="h-14 w-full rounded-2xl bg-[#ff8a1f] text-base font-extrabold text-black shadow-[0_10px_30px_rgba(255,138,31,0.22)] hover:bg-[#ff9d45] disabled:opacity-40"
            >
              가상 감시 시작
            </Button>
          )}
          {isReady && state.selectedCandidateIds.length === 0 && (
            <p className="-mt-2 text-sm text-white/45">감시를 시작하려면 후보 열차를 하나 이상 선택해주세요.</p>
          )}

          {!isReady && (
            <ProgressCard
              state={state}
              elapsedSeconds={elapsedSeconds}
              showHighlight={showHighlight}
              seatFoundCandidate={seatFoundCandidate}
              dispatch={dispatch}
            />
          )}
        </div>
      </div>
      <Toaster theme="dark" richColors position="top-center" />
    </main>
  );
}

function SearchConditionCard({
  state,
  dispatch,
  disabled,
}: {
  state: ReturnType<typeof createDefaultDemoState>;
  dispatch: React.Dispatch<DemoAction>;
  disabled: boolean;
}) {
  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()), []);
  return (
    <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <p className="text-sm font-bold text-white/70">검색 조건 (데모)</p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-3">
            <p className="mb-1 text-xs text-white/48">출발역</p>
            <p className="truncate text-base font-bold">{state.condition.departure}</p>
          </div>
          <Button
            type="button"
            aria-label="출발역과 도착역 바꾸기"
            disabled={disabled === false ? false : disabled}
            onClick={() => dispatch({ type: "SWAP_ROUTE" })}
            className="size-11 shrink-0 rounded-full border border-white/15 bg-[#191919] p-0 text-[#ff8a1f] hover:bg-[#242424] disabled:opacity-30"
          >
            <ArrowLeftRight className="size-5" />
          </Button>
          <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-3">
            <p className="mb-1 text-xs text-white/48">도착역</p>
            <p className="truncate text-base font-bold">{state.condition.arrival}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="rounded-2xl border border-white/10 bg-black/35 p-3">
            <span className="mb-1 flex items-center gap-1.5 text-xs text-white/48"><CalendarDays className="size-3.5" /> 출발일</span>
            <input
              type="date"
              min={today}
              value={state.condition.date}
              disabled={disabled}
              onChange={(event) => dispatch({ type: "SET_DATE", date: event.target.value })}
              className="min-h-11 w-full min-w-0 bg-transparent text-base font-bold outline-none [color-scheme:dark] disabled:opacity-50"
            />
          </label>
          <label className="rounded-2xl border border-white/10 bg-black/35 p-3">
            <span className="mb-1 flex items-center gap-1.5 text-xs text-white/48"><UsersRound className="size-3.5" /> 인원</span>
            <select
              value={state.condition.passengers}
              disabled={disabled}
              onChange={(event) => dispatch({ type: "SET_PASSENGERS", passengers: Number(event.target.value) })}
              className="min-h-11 w-full border-0 bg-transparent text-base font-bold outline-none disabled:opacity-50"
            >
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count} className="bg-[#111]">
                  성인 {count}명
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-white/45">
          <span className="rounded-full border border-white/10 px-3 py-1.5">열차 종류: 전체</span>
          <span className="rounded-full border border-white/10 px-3 py-1.5">좌석 등급: 일반실 우선</span>
          <span className="rounded-full border border-white/10 px-3 py-1.5">시간대: 05:00 ~ 10:00</span>
        </div>
      </CardContent>
    </Card>
  );
}

function CandidateListCard({
  state,
  dispatch,
  disabled,
}: {
  state: ReturnType<typeof createDefaultDemoState>;
  dispatch: React.Dispatch<DemoAction>;
  disabled: boolean;
}) {
  return (
    <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-white/70">후보 열차 (데모 fixture)</p>
          <span className="text-xs text-white/35">여러 열차 동시 선택 가능</span>
        </div>
        <div className="space-y-2">
          {state.candidates.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              jobStatus={state.status}
              selected={state.selectedCandidateIds.includes(candidate.id)}
              disabled={disabled}
              onToggle={() => dispatch({ type: "TOGGLE_CANDIDATE", candidateId: candidate.id })}
            />
          ))}
        </div>
        <p className="text-[11px] leading-5 text-white/32">
          열차번호·시각·운임은 화면 시연을 위한 데모 데이터이며 실제 운행정보가 아닙니다.
        </p>
      </CardContent>
    </Card>
  );
}

function CandidateRow({
  candidate,
  jobStatus,
  selected,
  disabled,
  onToggle,
}: {
  candidate: DemoCandidate;
  jobStatus: DemoStatus;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const statusKey = jobStatus === "READY" ? "idle" : candidate.status;
  const label = CANDIDATE_STATUS_LABEL[statusKey];
  const toneClass =
    statusKey === "seat_found"
      ? "border-emerald-400/40 bg-emerald-400/[0.08]"
      : statusKey === "stopped"
        ? "border-white/10 bg-black/20 opacity-60"
        : "border-white/10 bg-black/25";

  return (
    <label className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-2xl border p-3 transition ${toneClass} ${disabled ? "cursor-not-allowed" : ""}`}>
      <input
        type="checkbox"
        checked={selected}
        disabled={disabled}
        onChange={onToggle}
        className="size-5 shrink-0 accent-[#ff8a1f]"
        aria-label={`${candidate.trainNumber} 선택`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[11px] font-bold text-white/60">{candidate.trainType}</span>
          <span className="truncate text-sm font-bold">{candidate.trainNumber}</span>
        </div>
        <p className="mt-1 text-xs text-white/45">
          {candidate.departAt} 출발 → {candidate.arriveAt} 도착 · {candidate.fareLabel}
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
          statusKey === "seat_found" ? "bg-emerald-400/15 text-emerald-300" : statusKey === "stopped" ? "bg-white/[0.05] text-white/35" : "bg-white/[0.07] text-white/60"
        }`}
      >
        {label}
      </span>
    </label>
  );
}

function IntervalCard({ intervalSeconds, dispatch }: { intervalSeconds: DemoIntervalSeconds; dispatch: React.Dispatch<DemoAction> }) {
  return (
    <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <p className="text-sm font-bold text-white/70">시연 전환 간격</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="시연 전환 간격 선택">
          {INTERVAL_OPTIONS.map((seconds) => (
            <button
              key={seconds}
              type="button"
              aria-pressed={intervalSeconds === seconds}
              onClick={() => dispatch({ type: "SET_INTERVAL", seconds })}
              className={`min-h-11 min-w-11 rounded-xl border px-4 text-sm font-extrabold transition ${
                intervalSeconds === seconds ? "border-[#ff8a1f] bg-[#ff8a1f] text-black" : "border-white/12 bg-black/30 text-white/60 hover:border-white/25"
              }`}
            >
              {seconds}초
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-5 text-white/40">
          이 설정은 가상 시연의 화면 전환 속도이며 실제 철도 서버 조회 주기가 아닙니다.
        </p>
      </CardContent>
    </Card>
  );
}

function ProgressCard({
  state,
  elapsedSeconds,
  showHighlight,
  seatFoundCandidate,
  dispatch,
}: {
  state: ReturnType<typeof createDefaultDemoState>;
  elapsedSeconds: number;
  showHighlight: boolean;
  seatFoundCandidate: DemoCandidate | null;
  dispatch: React.Dispatch<DemoAction>;
}) {
  const canCancel = ACTIVE_STATUSES.includes(state.status);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  return (
    <div className="space-y-4">
      {showHighlight && (
        <div className="motion-reduce:animate-none animate-pulse rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4 text-sm font-bold text-emerald-300">
          <BellRing className="mb-1 size-5" /> 선택한 후보 중 하나에서 좌석이 발견된 것처럼 시연되고 있어요.
        </div>
      )}

      <Card className={`rounded-[28px] py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)] ${showHighlight ? "border-emerald-400/30 bg-emerald-400/[0.05]" : "border-white/10 bg-[#111]/90"}`}>
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold">
                {state.condition.departure} → {state.condition.arrival} · {state.condition.date}
              </p>
              <p className="mt-1 text-xs text-white/45">성인 {state.condition.passengers}명 · 후보 {state.selectedCandidateIds.length}개 선택</p>
            </div>
            <span className="flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-bold text-white/70">
              {state.status === "SEAT_FOUND" || state.status === "NOTIFIED" ? (
                <CircleCheck className="size-3.5 text-emerald-300" />
              ) : state.status === "CANCELLED" ? (
                <SquareX className="size-3.5 text-white/40" />
              ) : (
                <Hourglass className="size-3.5 text-[#ff9b3f]" />
              )}
              {STATUS_LABEL[state.status]}
            </span>
          </div>

          <p className="text-xs text-white/40">
            경과 시간 {minutes}분 {seconds.toString().padStart(2, "0")}초
          </p>

          <ul className="space-y-1.5">
            {state.candidates
              .filter((candidate) => state.selectedCandidateIds.includes(candidate.id))
              .map((candidate) => (
                <li key={candidate.id} className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-xs">
                  <span className="min-w-0 truncate text-white/70">{candidate.trainNumber} · {candidate.departAt} 출발</span>
                  <span className={candidate.status === "seat_found" ? "font-bold text-emerald-300" : candidate.status === "stopped" ? "text-white/35" : "text-white/55"}>
                    {CANDIDATE_STATUS_LABEL[candidate.status]}
                  </span>
                </li>
              ))}
          </ul>

          <Timeline history={state.history} />

          <div className="flex flex-wrap gap-2 pt-1">
            {canCancel && (
              <Button type="button" variant="outline" onClick={() => dispatch({ type: "CANCEL" })} className="h-11 rounded-xl border-white/15 text-white/60 hover:text-white">
                <SquareX className="size-4" /> 중단
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => dispatch({ type: "RESTART_JOURNEY" })} className="h-11 rounded-xl text-white/50 hover:text-white">
              <RefreshCcw className="size-4" /> 처음부터 다시 시작
            </Button>
          </div>
        </CardContent>
      </Card>

      {state.status === "NOTIFIED" && seatFoundCandidate && (
        <NotifiedSection state={state} seatFoundCandidate={seatFoundCandidate} dispatch={dispatch} />
      )}

      {(state.status === "FINISHED" || state.status === "CANCELLED") && (
        <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm leading-6 text-white/50">
          <p className="font-bold text-white/70">{state.status === "FINISHED" ? "시연을 종료했어요." : "시연을 중단했어요."}</p>
          <p className="mt-1">
            {state.status === "FINISHED"
              ? "실제 좌석은 확보되지 않았습니다. 처음부터 다시 시작하거나 데모를 초기화해 다른 조건으로 다시 시연해보세요."
              : "언제든 처음부터 다시 시작하거나 데모를 초기화할 수 있어요."}
          </p>
        </div>
      )}
    </div>
  );
}

function NotifiedSection({
  state,
  seatFoundCandidate,
  dispatch,
}: {
  state: ReturnType<typeof createDefaultDemoState>;
  seatFoundCandidate: DemoCandidate;
  dispatch: React.Dispatch<DemoAction>;
}) {
  const lastNotification = state.notifications[state.notifications.length - 1];
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden rounded-[28px] border-[#ff8a1f]/25 bg-[#ff8a1f]/[0.06] py-0 text-white">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm font-bold text-[#ffad62]">
            <BellRing className="size-4" /> 가상 알림 기록
          </div>
          {lastNotification && (
            <div className="rounded-xl border border-white/10 bg-black/25 p-3">
              <p className="text-sm font-bold">{lastNotification.title}</p>
              <p className="mt-1 text-xs leading-5 text-white/55">{lastNotification.body}</p>
            </div>
          )}
          <p className="text-[11px] leading-5 text-white/40">
            가상 알림입니다. 실제 Push 또는 메시지는 발송되지 않았습니다.
          </p>
        </CardContent>
      </Card>

      <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <p className="text-sm font-bold text-white/70">공식 예매 안내</p>
          <p className="text-xs leading-6 text-white/50">
            {seatFoundCandidate.trainNumber} · {seatFoundCandidate.departAt} 출발 조건으로 안내합니다. RailFlow는 로그인 정보나 검색 조건을
            공식 사이트로 전달하지 않으니, 도착하면 직접 조건을 입력해 좌석을 다시 확인해주세요.
          </p>
          <Button asChild className="h-12 w-full rounded-xl bg-white/10 font-extrabold text-white hover:bg-white/15">
            <a href={OFFICIAL_BOOKING_URL} target="_blank" rel="noreferrer">
              공식 예매로 이동 <ExternalLink className="size-4" />
            </a>
          </Button>
          <p className="flex items-start gap-1.5 text-[11px] leading-5 text-white/40">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-[#ff9b3f]" />
            RailFlow는 실제 좌석을 확보하지 않았습니다. 공식 예매 화면에서 좌석을 다시 확인하고 직접 예약·결제하세요.
          </p>
          <Button type="button" onClick={() => dispatch({ type: "FINISH" })} className="h-11 w-full rounded-xl bg-[#ff8a1f] font-extrabold text-black hover:bg-[#ff9d45]">
            시연 종료
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Timeline({ history }: { history: ReturnType<typeof createDefaultDemoState>["history"] }) {
  if (history.length === 0) return null;
  return (
    <ol className="space-y-1 border-l border-white/10 pl-3 text-[11px] text-white/40">
      {history.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="flex items-center gap-2">
          <CircleDashed className="size-3 shrink-0 text-white/25" />
          {STATUS_LABEL[entry.to]} · {new Date(entry.at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}
        </li>
      ))}
    </ol>
  );
}
