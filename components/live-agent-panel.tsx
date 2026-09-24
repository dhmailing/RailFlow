"use client";

// 실제 연동(로컬 Agent) 패널.
//
// 이 패널이 보여주는 상태는 전부 사용자의 PC에서 실제 공식 예매 화면을
// 읽어 온 것이다. 시뮬레이터(/demo, /demo/booking-automation)와 색·배지·문구로
// 확실히 구분한다: 시연은 주황색 "가상 시연", 여기는 붉은 테두리 + "실제".
//
// 이 패널은 절대 다음을 하지 않는다: 아이디/비밀번호/OTP 입력 요구, 결제
// 진행, 실제 조회 없이 "감시 중" 표시, 실제 예약 없이 "예약 성공" 표시.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleStop, Link2, Loader2, Play, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  JOB_STATE_LABEL,
  SEAT_STATUS_LABEL,
  TERMINAL_JOB_STATES,
  USER_ACTION_REQUIRED_STATES,
  type LiveAgentSnapshot,
  type LiveJobInput,
  type LiveJobState,
  type SeatPreference,
} from "@/lib/live/agent-protocol";
import {
  AgentPairingRequiredError,
  AgentUnavailableError,
  armReservation,
  confirmLogin,
  pingAgent,
  readPairingToken,
  startJob,
  stopJob,
  subscribe,
  writePairingToken,
} from "@/lib/live/agent-client";

export type LiveAgentPrefill = {
  departure: string;
  arrival: string;
  date: string;
  passengers: string;
  candidates: Array<{ id: string; trainNumber: string; departAt: string; arriveAt: string }>;
};

const SEAT_PREFERENCE_LABEL: Record<SeatPreference, string> = {
  any: "일반실 또는 특실",
  standard_only: "일반실만",
  first_only: "특실만",
};

function StateBadge({ state }: { state: LiveJobState }) {
  const key = state;
  const attention = USER_ACTION_REQUIRED_STATES.includes(key);
  const done = key === "RESERVED_PAYMENT_REQUIRED";
  const tone = done
    ? "bg-emerald-400/15 text-emerald-300"
    : attention
      ? "bg-red-500/15 text-red-300"
      : "bg-white/[0.07] text-white/70";
  return (
    <span className={`shrink-0 max-w-full whitespace-normal rounded-full px-2.5 py-1 text-[11px] font-bold leading-4 ${tone}`}>
      {JOB_STATE_LABEL[key]}
    </span>
  );
}

export default function LiveAgentPanel({ prefill }: { prefill: LiveAgentPrefill | null }) {
  const [agentUp, setAgentUp] = useState<boolean | null>(null);
  const [token, setToken] = useState(() => readPairingToken());
  const [tokenDraft, setTokenDraft] = useState("");
  const [snapshot, setSnapshot] = useState<LiveAgentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seatPreference, setSeatPreference] = useState<SeatPreference>("any");
  const [armOpen, setArmOpen] = useState(false);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    void pingAgent().then((up) => alive && setAgentUp(up));
    const timer = setInterval(() => {
      void pingAgent().then((up) => alive && setAgentUp(up));
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    unsubscribe.current?.();
    if (!token || !agentUp) return;
    unsubscribe.current = subscribe(setSnapshot, { token });
    return () => unsubscribe.current?.();
  }, [token, agentUp]);

  const job = snapshot?.job;
  const finished = job ? TERMINAL_JOB_STATES.includes(job.state) : false;

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      if (caught instanceof AgentPairingRequiredError) setToken("");
      setError(
        caught instanceof AgentUnavailableError || caught instanceof AgentPairingRequiredError
          ? caught.message
          : String((caught as Error)?.message ?? caught),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const armEcho = useMemo(() => {
    if (!job) return null;
    return {
      date: job.condition.date,
      departure: job.condition.departure,
      arrival: job.condition.arrival,
      passengers: String(job.condition.passengers),
      seatPreference: job.condition.seatPreference,
      trainNumbers: job.candidates.map((candidate) => candidate.trainNumber),
    };
  }, [job]);

  // --- Agent 미실행 / 미연결 안내 ---------------------------------------
  if (agentUp === false) {
    return (
      <Card data-testid="live-agent-panel" className="rounded-[28px] border-red-500/30 bg-[#140d0d]/90 py-0 text-white">
        <CardContent className="space-y-3 p-5">
          <p className="text-sm font-extrabold text-red-300">실제 연동 · PC에서 Agent 실행 필요</p>
          <p className="text-sm leading-6 text-white/60">
            실제 좌석 조회와 예약은 사용자의 Windows PC에서 실행되는 RailFlow Agent가 담당합니다. 이 화면(웹)은
            조건을 전달하고 상태를 보여주는 역할만 합니다.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-white/45">
            <li>PC에서 <code className="text-white/70">agent/scripts/1-설치.cmd</code> 를 한 번 실행합니다.</li>
            <li><code className="text-white/70">2-화면기록.cmd</code> 로 공식 예매 화면 프로필을 만듭니다.</li>
            <li><code className="text-white/70">3-감시시작.cmd</code> 를 실행하고, 창에 표시된 연결 코드를 여기에 입력합니다.</li>
          </ol>
          <p className="text-xs leading-5 text-white/35">
            브라우저를 닫거나 PC가 절전에 들어가면 감시가 멈춥니다. 화면을 꺼도 계속 도는 서버 감시가 아닙니다.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!token) {
    return (
      <Card data-testid="live-agent-panel" className="rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white">
        <CardContent className="space-y-3 p-5">
          <p className="text-sm font-extrabold">Agent 연결</p>
          <p className="text-sm leading-6 text-white/55">
            PC의 Agent 창에 표시된 연결 코드를 입력해 주세요. 코드는 Agent를 실행할 때마다 새로 만들어지며 저장되지
            않습니다.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Agent 연결 코드"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="예: a1b2c3"
              className="min-h-11 flex-1 basis-40 rounded-xl border border-white/12 bg-black/30 px-3 text-base font-bold"
            />
            <Button
              className="shrink-0"
              disabled={!tokenDraft.trim()}
              onClick={() => {
                writePairingToken(tokenDraft);
                setToken(tokenDraft.trim());
              }}
            >
              <Link2 className="size-4" /> 연결
            </Button>
          </div>
          {error && <p className="text-xs leading-5 text-red-300">{error}</p>}
        </CardContent>
      </Card>
    );
  }

  // --- 실제 연동 패널 ----------------------------------------------------
  return (
    <Card data-testid="live-agent-panel" className="rounded-[28px] border-red-500/30 bg-[#140d0d]/90 py-0 text-white">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-40">
            <p className="text-sm font-extrabold text-red-300">실제 연동 (시뮬레이터 아님)</p>
            <p className="mt-0.5 text-xs leading-5 text-white/45">
              {snapshot?.provider.operator ?? "대상 사업자"} · 조회 주기 {snapshot?.config.livePollingIntervalSeconds ?? "-"}초
              (고정)
            </p>
          </div>
          {job && <StateBadge state={job.state} />}
        </div>

        {job?.message && <p className="text-sm leading-6 text-white/70">{job.message}</p>}
        {error && (
          <p role="alert" className="flex items-start gap-2 text-sm leading-6 text-red-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        {/* 시작 전: 조건 확인 */}
        {!job && (
          <div className="space-y-3">
            {!prefill || prefill.candidates.length === 0 ? (
              <p className="text-sm leading-6 text-white/55">
                예매 화면에서 감시할 후보 열차를 먼저 선택해 주세요.
              </p>
            ) : (
              <>
                <dl className="grid gap-x-4 gap-y-1 text-sm leading-6 sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-white/40">구간</dt>
                    <dd className="font-bold">{prefill.departure} → {prefill.arrival}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-white/40">날짜</dt>
                    <dd className="font-bold">{prefill.date}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-white/40">인원</dt>
                    <dd className="font-bold">{prefill.passengers}명</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-white/40">후보</dt>
                    <dd className="font-bold">{prefill.candidates.map((c) => c.trainNumber).join(", ")}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-sm text-white/45" htmlFor="live-seat-pref">허용 좌석등급</label>
                  <select
                    id="live-seat-pref"
                    value={seatPreference}
                    onChange={(event) => setSeatPreference(event.target.value as SeatPreference)}
                    className="min-h-11 rounded-xl border border-white/12 bg-black/30 px-3 text-sm font-bold"
                  >
                    {(Object.keys(SEAT_PREFERENCE_LABEL) as SeatPreference[]).map((key) => (
                      <option key={key} value={key}>{SEAT_PREFERENCE_LABEL[key]}</option>
                    ))}
                  </select>
                </div>
                <p className="text-xs leading-5 text-white/35">
                  시작하면 읽기 전용으로 동작합니다. 좌석을 찾아도 예약 버튼을 누르지 않고 멈춰서 승인을 기다립니다.
                </p>
                <Button
                  data-testid="live-agent-start"
                  disabled={busy}
                  onClick={() =>
                    run(() => {
                      const input: LiveJobInput = {
                        departure: prefill.departure,
                        arrival: prefill.arrival,
                        date: prefill.date,
                        passengers: prefill.passengers,
                        seatPreference,
                        candidates: prefill.candidates,
                      };
                      return startJob(input, { token });
                    })
                  }
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  읽기 전용으로 감시 시작
                </Button>
              </>
            )}
          </div>
        )}

        {/* 실행 중 */}
        {job && (
          <div className="space-y-3">
            <ul className="space-y-2">
              {job.candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-white/10 bg-black/25 p-3"
                >
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-sm font-bold">{candidate.trainNumber}</p>
                    <p className="mt-0.5 text-xs leading-5 text-white/45">
                      {candidate.departAt} 출발 → {candidate.arriveAt} 도착 · 확인 {candidate.checkCount}회
                    </p>
                    {/* 화면에서 실제로 읽은 문구를 그대로 보여준다. */}
                    {candidate.lastScreenText && (
                      <p className="mt-1 text-xs leading-5 text-white/35">화면 표시: {candidate.lastScreenText}</p>
                    )}
                  </div>
                  <span className="shrink-0 max-w-full whitespace-normal rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-bold leading-4 text-white/60">
                    {candidate.lastSeatStatus ? SEAT_STATUS_LABEL[candidate.lastSeatStatus] : "확인 전"}
                  </span>
                </li>
              ))}
            </ul>

            {job.state === "WAITING_MANUAL_LOGIN" && (
              <div className="space-y-2 rounded-2xl border border-white/10 bg-black/25 p-3">
                <p className="text-sm leading-6 text-white/70">
                  열린 브라우저에서 <strong>직접</strong> 로그인해 주세요. RailFlow는 아이디·비밀번호·OTP를 입력하거나
                  저장하지 않습니다.
                </p>
                <Button disabled={busy} onClick={() => run(() => confirmLogin({ token }))}>
                  로그인 완료
                </Button>
              </div>
            )}

            {job.state === "AWAITING_ARM_CONFIRMATION" && armEcho && (
              <div className="space-y-3 rounded-2xl border border-red-500/40 bg-red-500/[0.07] p-3">
                <p className="flex items-start gap-2 text-sm font-extrabold text-red-300">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  실제 예약을 진행하면 아래 조건으로 진짜 예약이 생성될 수 있습니다.
                </p>
                <dl className="grid gap-x-4 gap-y-1 text-sm leading-6 sm:grid-cols-2">
                  <div className="flex gap-2"><dt className="text-white/40">날짜</dt><dd className="font-bold">{armEcho.date}</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">구간</dt><dd className="font-bold">{armEcho.departure} → {armEcho.arrival}</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">인원</dt><dd className="font-bold">{armEcho.passengers}명</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">좌석등급</dt><dd className="font-bold">{SEAT_PREFERENCE_LABEL[armEcho.seatPreference]}</dd></div>
                  <div className="flex gap-2 sm:col-span-2"><dt className="text-white/40">후보 열차</dt><dd className="font-bold">{armEcho.trainNumbers.join(", ")}</dd></div>
                </dl>
                <p className="text-xs leading-5 text-white/55">
                  결제는 자동으로 진행되지 않습니다. 예약이 확인되면 결제 직전에 멈추고, 결제는 공식 예매 서비스에서
                  직접 하셔야 합니다.
                </p>
                {!armOpen ? (
                  <Button variant="ghost" className="border border-red-500/40" onClick={() => setArmOpen(true)}>
                    실제 예약 진행 검토
                  </Button>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      data-testid="live-agent-arm"
                      disabled={busy}
                      onClick={() => run(() => armReservation(armEcho, { token }))}
                    >
                      위 조건으로 실제 예약 승인
                    </Button>
                    <Button variant="ghost" onClick={() => setArmOpen(false)}>취소</Button>
                  </div>
                )}
              </div>
            )}

            {job.state === "RESERVED_PAYMENT_REQUIRED" && job.reservation?.confirmed && (
              <div className="space-y-2 rounded-2xl border border-emerald-400/40 bg-emerald-400/[0.07] p-3">
                <p className="text-sm font-extrabold text-emerald-300">예약 성공 · 결제 필요</p>
                <dl className="grid gap-x-4 gap-y-1 text-sm leading-6 sm:grid-cols-2">
                  <div className="flex gap-2"><dt className="text-white/40">열차</dt><dd className="font-bold">{job.reservation.trainNumber}</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">일시</dt><dd className="font-bold">{job.reservation.date} {job.reservation.departAt}</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">구간</dt><dd className="font-bold">{job.reservation.departure} → {job.reservation.arrival}</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">인원·등급</dt><dd className="font-bold">{job.reservation.passengers}명 · {SEAT_PREFERENCE_LABEL[job.reservation.seatPreference ?? "any"]}</dd></div>
                  <div className="flex gap-2"><dt className="text-white/40">예약번호</dt><dd className="font-bold">{job.reservation.reservationNumber ?? "화면에서 확인 필요"}</dd></div>
                  <div className="flex gap-2">
                    <dt className="text-white/40">결제기한</dt>
                    {/* 화면에서 읽지 못했으면 추정값을 만들지 않는다. */}
                    <dd className="font-bold">
                      {job.reservation.paymentDeadline?.iso ?? "화면에서 확인하지 못했습니다"}
                    </dd>
                  </div>
                </dl>
                <p className="text-sm font-bold leading-6 text-emerald-200">
                  사용자가 공식 예매 서비스에서 직접 결제해야 합니다.
                </p>
              </div>
            )}

            {!finished && (
              <Button
                data-testid="live-agent-stop"
                variant="ghost"
                className="border border-white/15"
                disabled={busy}
                onClick={() => run(() => stopJob({ token }))}
              >
                <CircleStop className="size-4" /> 중단
              </Button>
            )}

            <p className="text-xs leading-5 text-white/35">
              이 감시는 PC의 Agent 창이 열려 있는 동안에만 동작합니다. 창을 닫거나 PC가 절전에 들어가면 멈춥니다.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
