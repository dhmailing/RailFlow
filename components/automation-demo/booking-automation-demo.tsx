"use client";

// Public, login-free demonstration of RailFlow's v0.7 automation macro flow
// (조건 등록 -> 자동 감시 -> 자동 좌석조회 -> 좌석 발견 -> 자동 구매클릭 ->
// 자동 예약 -> 다른 후보 자동 중단 -> 가상 예약번호·결제기한 표시). Fully
// client-only: every byte of state lives in this tab's sessionStorage,
// driven by the pure reducer in lib/automation-demo/reducer.ts and a
// single-slot timer (lib/automation-demo/timer.ts). This component never
// calls /api/auth/**, /api/automation-jobs/**, /api/automation/mock-site/**,
// or any real railway/notification API -- see lib/automation-demo/types.ts's
// header comment for why this page exists (AUTH_STORE is unusable on Vercel
// Preview today because isAuthStoreUsable() is keyed on NODE_ENV, and
// Preview builds run with NODE_ENV=production).
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { CalendarDays, CircleCheck, CircleDashed, Clock, LoaderCircle, RefreshCcw, RotateCcw, Sparkles, SquareX, TicketCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import {
  automationDemoReducer,
  computeElapsedSeconds,
  createDefaultAutomationDemoState,
  MIN_SELECTED_CANDIDATES,
  type AutomationDemoAction,
} from "@/lib/automation-demo/reducer";
import { createAutomationDemoTimerController } from "@/lib/automation-demo/timer";
import { clearAutomationDemoState, readAutomationDemoState, writeAutomationDemoState } from "@/lib/automation-demo/storage";
import type { AutomationDemoCandidate, AutomationDemoIntervalSeconds, AutomationDemoStatus } from "@/lib/automation-demo/types";

const STATUS_LABEL: Record<AutomationDemoStatus, string> = {
  READY: "조건 설정",
  WATCHING: "자동 감시 중",
  SEAT_FOUND: "좌석 발견",
  PURCHASE_CLICKING: "자동 구매클릭 중",
  RESERVING: "자동 예약 요청 중",
  PAYMENT_PENDING: "결제 대기",
  COMPLETED: "예약 성공",
  CANCELLED: "시연 중단됨",
};

const CANDIDATE_STATUS_LABEL: Record<"idle" | "waiting" | "checking" | "sold_out" | "seat_found" | "stopped", string> = {
  idle: "확인 필요",
  waiting: "대기",
  checking: "확인 중",
  sold_out: "매진(재판매 없음)",
  seat_found: "좌석 발견",
  stopped: "다른 열차 예약 성공으로 자동 중단",
};

const INTERVAL_OPTIONS: AutomationDemoIntervalSeconds[] = [1, 2, 3, 4, 5];
const ACTIVE_STATUSES: readonly AutomationDemoStatus[] = ["WATCHING", "SEAT_FOUND", "PURCHASE_CLICKING", "RESERVING", "PAYMENT_PENDING"];

function reducerWithHydrate(
  state: ReturnType<typeof createDefaultAutomationDemoState>,
  action: AutomationDemoAction | { type: "HYDRATE"; state: ReturnType<typeof createDefaultAutomationDemoState> },
) {
  if (action.type === "HYDRATE") return action.state;
  return automationDemoReducer(state, action);
}

export default function BookingAutomationDemo() {
  const [state, dispatch] = useReducer(reducerWithHydrate, undefined, createDefaultAutomationDemoState);
  const [hydrated, setHydrated] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const timerRef = useRef(createAutomationDemoTimerController());
  const completedOnceRef = useRef<string | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = readAutomationDemoState(window.sessionStorage);
      if (saved) dispatch({ type: "HYDRATE", state: saved });
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeAutomationDemoState(window.sessionStorage, state);
  }, [state, hydrated]);

  // 유일한 자동 전이 타이머(§5 "자동 감시 시작 이후에는 예약 성공까지 자동
  // 진행"). PAYMENT_PENDING만 예외 -- 결제 완료는 사용자가 직접 눌러야
  // 한다(§5).
  useEffect(() => {
    const controller = timerRef.current;
    const delayMs = state.intervalSeconds * 1000;
    if (state.status === "WATCHING") {
      controller.schedule(() => dispatch({ type: "TICK" }), delayMs);
    } else if (state.status === "SEAT_FOUND") {
      controller.schedule(() => dispatch({ type: "ADVANCE_TO_PURCHASE_CLICKING" }), delayMs);
    } else if (state.status === "PURCHASE_CLICKING") {
      controller.schedule(() => dispatch({ type: "ADVANCE_TO_RESERVING" }), delayMs);
    } else if (state.status === "RESERVING") {
      controller.schedule(() => dispatch({ type: "COMPLETE_RESERVATION" }), delayMs);
    } else {
      controller.clear();
    }
    return () => controller.clear();
  }, [state.status, state.intervalSeconds, state.watchTick]);

  // PAYMENT_PENDING 진입 시 1회 토스트(§7). completedOnceRef로 같은
  // reservationNumber에 대해 중복 실행을 막는다.
  useEffect(() => {
    if (state.status !== "PAYMENT_PENDING" || !state.reservationNumber) return;
    if (completedOnceRef.current === state.reservationNumber) return;
    completedOnceRef.current = state.reservationNumber;
    toast.success("예약 성공", { description: `가상 예약번호 ${state.reservationNumber}` });
  }, [state.status, state.reservationNumber]);

  useEffect(() => {
    if (!ACTIVE_STATUSES.includes(state.status)) return undefined;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.status]);

  const elapsedSeconds = useMemo(() => computeElapsedSeconds(state, nowTick), [state, nowTick]);

  const resetDemo = () => {
    timerRef.current.clear();
    clearAutomationDemoState(window.sessionStorage);
    completedOnceRef.current = null;
    dispatch({ type: "HYDRATE", state: createDefaultAutomationDemoState() });
    toast("시연을 초기화했어요");
  };

  const isReady = state.status === "READY";
  const foundCandidate = state.candidates.find((candidate) => candidate.id === state.foundCandidateId) ?? null;

  return (
    <main className="min-h-dvh bg-[#070707] text-white">
      <div className="mx-auto min-h-dvh max-w-3xl border-x border-white/[0.06] bg-[radial-gradient(circle_at_50%_-12%,rgba(255,137,31,0.15),transparent_34%)] pb-16">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#070707]/95 backdrop-blur-xl">
          <div className="flex items-center justify-between px-4 py-3 sm:px-6">
            <Link href="/" className="text-sm font-bold text-white/60 hover:text-white">
              ← RailFlow로 돌아가기
            </Link>
            <Button size="sm" variant="ghost" onClick={resetDemo} className="rounded-lg text-xs text-white/50 hover:text-white">
              <RotateCcw className="size-3.5" /> 시연 초기화
            </Button>
          </div>
          <div className="flex items-center gap-2 border-t border-white/[0.06] bg-[#ff8a1f]/[0.08] px-4 py-2.5 text-xs font-bold text-[#ffad62] sm:px-6">
            <Sparkles className="size-4 shrink-0" />
            자동 좌석조회·구매·예약 과정을 재현하는 가상 시연입니다. 실제 철도 좌석 조회, 예약 또는 결제를 수행하지 않습니다.
          </div>
        </header>

        <div className="space-y-5 px-4 pt-5 sm:px-6">
          <div>
            <p className="text-sm font-semibold text-[#ff9b3f]">자동 좌석조회·예약 매크로 시연</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-[-0.03em]">로그인 없이 바로 시연</h1>
            <p className="mt-2 text-sm leading-6 text-white/45">
              계정·서버 저장소를 전혀 쓰지 않는 브라우저 전용 시연입니다. 조건을 등록하고 &ldquo;자동 감시 시작&rdquo;을 누르면 좌석
              발견부터 가상 예약 성공까지 자동으로 진행됩니다.
            </p>
          </div>

          <p aria-live="polite" role="status" className="sr-only">
            현재 상태: {STATUS_LABEL[state.status]}
          </p>

          <ConditionCard state={state} dispatch={dispatch} disabled={!isReady} />
          <CandidateListCard state={state} dispatch={dispatch} disabled={!isReady} />
          <IntervalCard intervalSeconds={state.intervalSeconds} dispatch={dispatch} disabled={!isReady} />

          {isReady && (
            <Button
              type="button"
              disabled={state.selectedCandidateIds.length < MIN_SELECTED_CANDIDATES}
              onClick={() => dispatch({ type: "START_WATCHING" })}
              className="h-14 w-full rounded-2xl bg-[#ff8a1f] text-base font-extrabold text-black shadow-[0_10px_30px_rgba(255,138,31,0.22)] hover:bg-[#ff9d45] disabled:opacity-40"
            >
              자동 감시 시작
            </Button>
          )}
          {isReady && state.selectedCandidateIds.length < MIN_SELECTED_CANDIDATES && (
            <p className="-mt-2 text-sm text-white/45">감시를 시작하려면 후보 열차를 {MIN_SELECTED_CANDIDATES}개 이상 선택해주세요.</p>
          )}

          {!isReady && (
            <ProgressCard state={state} elapsedSeconds={elapsedSeconds} foundCandidate={foundCandidate} dispatch={dispatch} />
          )}
        </div>
      </div>
      <Toaster theme="dark" richColors position="top-center" />
    </main>
  );
}

function ConditionCard({
  state,
  dispatch,
  disabled,
}: {
  state: ReturnType<typeof createDefaultAutomationDemoState>;
  dispatch: React.Dispatch<AutomationDemoAction>;
  disabled: boolean;
}) {
  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()), []);
  return (
    <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <p className="text-sm font-bold text-white/70">검색 조건 (시연)</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-3">
            <p className="mb-1 text-xs text-white/48">출발역</p>
            <p className="truncate text-base font-bold">{state.condition.departure}</p>
          </div>
          <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-3">
            <p className="mb-1 text-xs text-white/48">도착역</p>
            <p className="truncate text-base font-bold">{state.condition.arrival}</p>
          </div>
        </div>

        <label className="block rounded-2xl border border-white/10 bg-black/35 p-3">
          <span className="mb-1 flex items-center gap-1.5 text-xs text-white/48">
            <CalendarDays className="size-3.5" /> 출발일
          </span>
          <input
            type="date"
            min={today}
            value={state.condition.date}
            disabled={disabled}
            onChange={(event) => dispatch({ type: "SET_DATE", date: event.target.value })}
            className="min-h-11 w-full min-w-0 bg-transparent text-base font-bold outline-none [color-scheme:dark] disabled:opacity-50"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="rounded-2xl border border-white/10 bg-black/35 p-3">
            <span className="mb-1 flex items-center gap-1.5 text-xs text-white/48">
              <Clock className="size-3.5" /> 희망 시작
            </span>
            <input
              type="time"
              value={state.condition.timeRangeStart}
              disabled={disabled}
              onChange={(event) => dispatch({ type: "SET_TIME_RANGE_START", time: event.target.value })}
              className="min-h-11 w-full min-w-0 bg-transparent text-base font-bold outline-none [color-scheme:dark] disabled:opacity-50"
            />
          </label>
          <label className="rounded-2xl border border-white/10 bg-black/35 p-3">
            <span className="mb-1 flex items-center gap-1.5 text-xs text-white/48">
              <Clock className="size-3.5" /> 희망 종료
            </span>
            <input
              type="time"
              value={state.condition.timeRangeEnd}
              disabled={disabled}
              onChange={(event) => dispatch({ type: "SET_TIME_RANGE_END", time: event.target.value })}
              className="min-h-11 w-full min-w-0 bg-transparent text-base font-bold outline-none [color-scheme:dark] disabled:opacity-50"
            />
          </label>
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
  state: ReturnType<typeof createDefaultAutomationDemoState>;
  dispatch: React.Dispatch<AutomationDemoAction>;
  disabled: boolean;
}) {
  return (
    <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-white/70">후보 열차 (시연 fixture)</p>
          <span className="text-xs text-white/35">{MIN_SELECTED_CANDIDATES}개 이상 선택</span>
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
        <p className="text-[11px] leading-5 text-white/32">열차번호·시각·운임은 시연용 데이터이며 실제 운행정보가 아닙니다.</p>
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
  candidate: AutomationDemoCandidate;
  jobStatus: AutomationDemoStatus;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const statusKey = jobStatus === "READY" ? "idle" : candidate.status;
  const label = CANDIDATE_STATUS_LABEL[statusKey];
  const toneClass =
    statusKey === "seat_found"
      ? "border-emerald-400/40 bg-emerald-400/[0.08]"
      : statusKey === "stopped" || statusKey === "sold_out"
        ? "border-white/10 bg-black/20 opacity-60"
        : "border-white/10 bg-black/25";

  return (
    <label
      data-testid="demo-candidate-row"
      data-candidate-id={candidate.id}
      data-candidate-status={statusKey}
      data-check-count={candidate.checkCount}
      className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-2xl border p-3 transition ${toneClass} ${disabled ? "cursor-not-allowed" : ""}`}
    >
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
          {candidate.departAt} 출발 → {candidate.arriveAt} 도착 · {candidate.fareLabel} · 확인 {candidate.checkCount}회차
        </p>
      </div>
      <span
        className={`shrink-0 max-w-[38%] rounded-full px-2.5 py-1 text-right text-[11px] font-bold leading-4 ${
          statusKey === "seat_found" ? "bg-emerald-400/15 text-emerald-300" : statusKey === "stopped" || statusKey === "sold_out" ? "bg-white/[0.05] text-white/35" : "bg-white/[0.07] text-white/60"
        }`}
      >
        {label}
      </span>
    </label>
  );
}

function IntervalCard({ intervalSeconds, dispatch, disabled }: { intervalSeconds: AutomationDemoIntervalSeconds; dispatch: React.Dispatch<AutomationDemoAction>; disabled: boolean }) {
  return (
    <Card className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <p className="text-sm font-bold text-white/70">자동 확인 간격</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="자동 확인 간격 선택">
          {INTERVAL_OPTIONS.map((seconds) => (
            <button
              key={seconds}
              type="button"
              disabled={disabled}
              aria-pressed={intervalSeconds === seconds}
              onClick={() => dispatch({ type: "SET_INTERVAL", seconds })}
              className={`min-h-11 min-w-11 rounded-xl border px-4 text-sm font-extrabold transition disabled:opacity-40 ${
                intervalSeconds === seconds ? "border-[#ff8a1f] bg-[#ff8a1f] text-black" : "border-white/12 bg-black/30 text-white/60 hover:border-white/25"
              }`}
            >
              {seconds}초
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-5 text-white/40">이 설정은 이 시연 화면의 자동 확인 주기이며 실제 철도 서버 조회 주기가 아닙니다.</p>
      </CardContent>
    </Card>
  );
}

function ProgressCard({
  state,
  elapsedSeconds,
  foundCandidate,
  dispatch,
}: {
  state: ReturnType<typeof createDefaultAutomationDemoState>;
  elapsedSeconds: number;
  foundCandidate: AutomationDemoCandidate | null;
  dispatch: React.Dispatch<AutomationDemoAction>;
}) {
  const canCancel = ACTIVE_STATUSES.includes(state.status);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const showHighlight = state.status === "SEAT_FOUND" || state.status === "PURCHASE_CLICKING" || state.status === "RESERVING";

  return (
    <div className="space-y-4">
      {showHighlight && (
        <div className="motion-reduce:animate-none animate-pulse rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4 text-sm font-bold text-emerald-300">
          <LoaderCircle className="mb-1 size-5 animate-spin" /> {STATUS_LABEL[state.status]}
        </div>
      )}

      <Card className={`rounded-[28px] py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)] ${showHighlight ? "border-emerald-400/30 bg-emerald-400/[0.05]" : "border-white/10 bg-[#111]/90"}`}>
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold">
                {state.condition.departure} → {state.condition.arrival} · {state.condition.date}
              </p>
              <p className="mt-1 text-xs text-white/45">후보 {state.selectedCandidateIds.length}개 선택 · {state.intervalSeconds}초 간격</p>
            </div>
            <span data-testid="demo-status" data-status={state.status} className="flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-bold text-white/70">
              {state.status === "PAYMENT_PENDING" || state.status === "COMPLETED" ? (
                <CircleCheck className="size-3.5 text-emerald-300" />
              ) : state.status === "CANCELLED" ? (
                <SquareX className="size-3.5 text-white/40" />
              ) : (
                <LoaderCircle className="size-3.5 animate-spin text-[#ff9b3f]" />
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
                  <span className="min-w-0 truncate text-white/70">
                    {candidate.trainNumber} · {candidate.departAt} 출발 · 확인 {candidate.checkCount}회차
                  </span>
                  <span
                    className={
                      candidate.status === "seat_found"
                        ? "font-bold text-emerald-300"
                        : candidate.status === "stopped" || candidate.status === "sold_out"
                          ? "text-white/35"
                          : "text-white/55"
                    }
                  >
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
          </div>
        </CardContent>
      </Card>

      {(state.status === "PAYMENT_PENDING" || state.status === "COMPLETED") && foundCandidate && (
        <ReservationResultSection state={state} foundCandidate={foundCandidate} dispatch={dispatch} />
      )}

      {state.status === "CANCELLED" && (
        <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm leading-6 text-white/50">
          <p className="font-bold text-white/70">시연을 중단했어요.</p>
          <p className="mt-1">언제든 시연을 초기화해 다시 시작할 수 있어요.</p>
        </div>
      )}
    </div>
  );
}

function ReservationResultSection({
  state,
  foundCandidate,
  dispatch,
}: {
  state: ReturnType<typeof createDefaultAutomationDemoState>;
  foundCandidate: AutomationDemoCandidate;
  dispatch: React.Dispatch<AutomationDemoAction>;
}) {
  const seatLabel = foundCandidate.scenario.kind === "seat_after_n_checks" ? (foundCandidate.scenario.seatClass === "standard" ? "일반실 1석" : "특실 1석") : "";
  const otherStoppedCandidates = state.candidates.filter((candidate) => state.selectedCandidateIds.includes(candidate.id) && candidate.id !== foundCandidate.id);

  return (
    <div className="space-y-4">
      <Card data-testid="demo-reservation-result" data-reservation-number={state.reservationNumber} data-payment-deadline={state.paymentDeadline} className="overflow-hidden rounded-[28px] border-emerald-400/30 bg-emerald-400/[0.06] py-0 text-white">
        <CardContent className="space-y-2 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm font-extrabold text-emerald-300">
            <TicketCheck className="size-4" /> 예약 성공
          </div>
          <p className="text-lg font-extrabold">{foundCandidate.trainNumber}</p>
          <p className="text-sm text-white/70">
            {state.condition.departure} {foundCandidate.departAt} → {state.condition.arrival} {foundCandidate.arriveAt}
          </p>
          <p className="text-sm text-white/70">{seatLabel}</p>
          <p className="text-sm font-bold text-emerald-300">가상 예약번호: {state.reservationNumber}</p>
          {state.paymentDeadline && (
            <p className="text-sm text-white/60">
              결제기한: {new Date(state.paymentDeadline).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}
            </p>
          )}
          <p className="text-[11px] leading-5 text-white/40">가상 예약입니다. 실제 결제나 좌석 확보는 이뤄지지 않았습니다.</p>
        </CardContent>
      </Card>

      {otherStoppedCandidates.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-black/25 p-3 text-xs text-white/45">
          {otherStoppedCandidates.map((candidate) => (
            <p key={candidate.id}>
              {candidate.trainNumber}: {CANDIDATE_STATUS_LABEL.stopped}
            </p>
          ))}
        </div>
      )}

      {state.status === "PAYMENT_PENDING" && (
        <Button type="button" onClick={() => dispatch({ type: "CONFIRM_PAYMENT" })} className="h-12 w-full rounded-xl bg-[#ff8a1f] font-extrabold text-black hover:bg-[#ff9d45]">
          결제 완료
        </Button>
      )}

      {state.status === "COMPLETED" && (
        <Button type="button" variant="outline" onClick={() => dispatch({ type: "RESTART_WATCH" })} className="h-11 w-full rounded-xl border-white/15 text-white/60 hover:text-white">
          <RefreshCcw className="size-4" /> 다시 감시
        </Button>
      )}
    </div>
  );
}

function Timeline({ history }: { history: ReturnType<typeof createDefaultAutomationDemoState>["history"] }) {
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
