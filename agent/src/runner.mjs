// 감시 루프.
//
// 한 번에 하나의 작업만 돌린다. 후보 열차가 여럿이어도 한 브라우저 세션에서
// 순차로 확인한다(지침 §9). 예약이 확인되면 나머지 후보는 즉시 중단한다.

import {
  NETWORK_BACKOFF_SECONDS,
  MANUAL_LOGIN_TIMEOUT_MINUTES,
  MIN_LIVE_POLLING_INTERVAL_SECONDS,
  resolveConfig,
} from "./config.mjs";
import { log } from "./log.mjs";
import { redactValue, safeScreenText } from "./redact.mjs";
import { assertTransition, isTerminal, resolveUserStopTarget } from "./machine.mjs";
import { JobState, RunMode, SeatStatus, HaltReason, SEAT_STATUS_HALT } from "./status.mjs";
import { activeJobKey, seatStatusSatisfies } from "./match.mjs";
import { assertProviderContract } from "./providers/provider-contract.mjs";
import { ProviderHalt } from "./providers/provider-halt.mjs";

const SEAT_STATUS_TO_JOB_STATE = Object.freeze({
  [SeatStatus.AUTH_REQUIRED]: JobState.AUTH_REQUIRED,
  [SeatStatus.ADDITIONAL_VERIFICATION_REQUIRED]: JobState.ADDITIONAL_VERIFICATION_REQUIRED,
  [SeatStatus.QUEUE_OR_ACCESS_RESTRICTED]: JobState.QUEUE_OR_ACCESS_RESTRICTED,
  [SeatStatus.PROVIDER_CHANGED]: JobState.PROVIDER_CHANGED,
});

const HALT_REASON_TO_JOB_STATE = Object.freeze({
  [HaltReason.LOGIN_EXPIRED]: JobState.AUTH_REQUIRED,
  [HaltReason.ADDITIONAL_VERIFICATION]: JobState.ADDITIONAL_VERIFICATION_REQUIRED,
  [HaltReason.CAPTCHA_DETECTED]: JobState.ADDITIONAL_VERIFICATION_REQUIRED,
  [HaltReason.QUEUE_DETECTED]: JobState.QUEUE_OR_ACCESS_RESTRICTED,
  [HaltReason.ACCESS_RESTRICTED]: JobState.QUEUE_OR_ACCESS_RESTRICTED,
  [HaltReason.PROVIDER_LAYOUT_CHANGED]: JobState.PROVIDER_CHANGED,
  [HaltReason.PROVIDER_PROFILE_REQUIRED]: JobState.PROVIDER_CHANGED,
  [HaltReason.TRAIN_IDENTIFICATION_UNCERTAIN]: JobState.PROVIDER_CHANGED,
  [HaltReason.UNEXPECTED_PAYMENT_SCREEN]: JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  [HaltReason.RESERVATION_RESULT_UNCERTAIN]: JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  [HaltReason.EXISTING_RESERVATION_FOUND]: JobState.RECONCILIATION_REQUIRED,
  [HaltReason.HOST_NOT_ALLOWED]: JobState.FAILED,
  [HaltReason.LOCK_LOST]: JobState.FAILED,
  [HaltReason.NETWORK_BACKOFF_EXHAUSTED]: JobState.FAILED,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class JobRunner {
  #config;
  #lock;
  #provider;
  #job = null;
  #listeners = new Set();
  #stopRequested = false;
  #loginConfirmed = false;
  #armConfirmed = false;
  #loop = null;

  constructor({ config = resolveConfig(), lock, provider }) {
    assertProviderContract(provider);
    // 실제 사이트 조회 주기의 하한은 여기서도 한 번 더 강제한다. 설정을
    // 거치지 않고 직접 만든 config 로도 하한 아래로 내려가지 않게 한다.
    this.#config = {
      ...config,
      livePollingIntervalSeconds: Math.max(
        MIN_LIVE_POLLING_INTERVAL_SECONDS,
        Number(config.livePollingIntervalSeconds) || MIN_LIVE_POLLING_INTERVAL_SECONDS,
      ),
    };
    this.#lock = lock;
    this.#provider = provider;
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** UI로 내보내는 상태. 항상 마스킹을 거친다. */
  snapshot() {
    if (!this.#job) {
      return {
        active: false,
        provider: { name: this.#provider.name, operator: this.#provider.operator, simulation: false },
        config: { livePollingIntervalSeconds: this.#config.livePollingIntervalSeconds },
      };
    }
    return redactValue({
      active: !isTerminal(this.#job.state),
      provider: { name: this.#provider.name, operator: this.#provider.operator, simulation: false },
      config: { livePollingIntervalSeconds: this.#config.livePollingIntervalSeconds },
      job: {
        id: this.#job.id,
        mode: this.#job.mode,
        state: this.#job.state,
        haltReason: this.#job.haltReason,
        condition: this.#job.condition,
        candidates: this.#job.candidates.map((c) => ({
          id: c.id,
          trainNumber: c.trainNumber,
          departAt: c.departAt,
          arriveAt: c.arriveAt,
          state: c.state,
          lastSeatStatus: c.lastSeatStatus,
          lastScreenText: c.lastScreenText,
          checkedAt: c.checkedAt,
          checkCount: c.checkCount,
        })),
        reservation: this.#job.reservation,
        checkCount: this.#job.checkCount,
        startedAt: this.#job.startedAt,
        updatedAt: this.#job.updatedAt,
        message: this.#job.message,
      },
    });
  }

  #emit() {
    if (this.#job) this.#job.updatedAt = new Date().toISOString();
    const snap = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snap);
      } catch (error) {
        log.warn("상태 구독자 오류", { error });
      }
    }
  }

  #setState(next, { message = null, haltReason = null } = {}) {
    const from = this.#job.state;
    if (from === next) {
      if (message) this.#job.message = message;
      this.#emit();
      return;
    }
    assertTransition(from, next, this.#job.mode);
    this.#job.state = next;
    this.#job.message = message;
    this.#job.haltReason = haltReason;
    log.info("상태 변경", { from, to: next, haltReason, message });
    this.#emit();
  }

  confirmLogin() {
    this.#loginConfirmed = true;
  }

  /**
   * 사용자가 실제 예약을 승인한다. 승인 화면에서 본 조건과 지금 작업의
   * 조건이 같은지 다시 확인한다 -- 화면에 보인 것과 다른 열차를 예약하면
   * 안 되기 때문이다(지침 §10, §13).
   */
  confirmArm(echo) {
    if (!this.#job) throw new Error("실행 중인 작업이 없습니다.");
    const expected = {
      date: this.#job.condition.date,
      departure: this.#job.condition.departure,
      arrival: this.#job.condition.arrival,
      passengers: String(this.#job.condition.passengers),
      seatPreference: this.#job.condition.seatPreference,
      trainNumbers: this.#job.candidates.map((c) => c.trainNumber).join(","),
    };
    const actual = {
      date: echo?.date,
      departure: echo?.departure,
      arrival: echo?.arrival,
      passengers: String(echo?.passengers),
      seatPreference: echo?.seatPreference,
      trainNumbers: Array.isArray(echo?.trainNumbers) ? echo.trainNumbers.join(",") : echo?.trainNumbers,
    };
    const mismatched = Object.keys(expected).filter((key) => expected[key] !== actual[key]);
    if (mismatched.length > 0) {
      throw new Error(
        `승인 화면의 조건이 실행 중인 작업과 다릅니다(${mismatched.join(", ")}). 예약을 시작하지 않습니다.`,
      );
    }
    this.#job.mode = RunMode.LIVE_RESERVATION_ARMED;
    this.#armConfirmed = true;
    log.info("사용자가 실제 예약을 승인했습니다.", { jobId: this.#job.id });
    this.#emit();
  }

  requestStop() {
    this.#stopRequested = true;
    log.info("사용자가 중단을 요청했습니다.");
  }

  /**
   * 작업 시작. 중복 방지를 위해 같은 키의 활성 작업이 있으면 거절한다.
   */
  async start(input) {
    if (this.#job && !isTerminal(this.#job.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다. 먼저 중단해 주세요.");
    }
    const key = activeJobKey({
      userId: input.userId,
      date: input.date,
      departure: input.departure,
      arrival: input.arrival,
      passengers: input.passengers,
    });
    this.#stopRequested = false;
    this.#loginConfirmed = false;
    this.#armConfirmed = false;
    this.#job = {
      id: `live-${Date.now()}`,
      key,
      // 시작은 항상 읽기 전용이다. ARMED 는 사용자가 따로 승인해야 한다.
      mode: RunMode.LIVE_READ_ONLY,
      state: JobState.IDLE,
      haltReason: null,
      message: null,
      condition: {
        departure: input.departure,
        arrival: input.arrival,
        date: input.date,
        passengers: input.passengers,
        seatPreference: input.seatPreference ?? "any",
        timeFrom: input.timeFrom ?? null,
        timeTo: input.timeTo ?? null,
      },
      candidates: (input.candidates ?? []).map((c) => ({
        ...c,
        state: "PENDING",
        lastSeatStatus: null,
        lastScreenText: null,
        checkedAt: null,
        checkCount: 0,
        rowIndex: null,
      })),
      reservation: null,
      checkCount: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (this.#job.candidates.length === 0) throw new Error("후보 열차가 없습니다.");
    this.#emit();
    this.#loop = this.#run().catch((error) => {
      log.error("감시 루프가 예기치 않게 끝났습니다.", { error });
    });
    return this.#job.id;
  }

  async waitUntilIdle() {
    if (this.#loop) await this.#loop;
  }

  #halt(error) {
    const reason = error instanceof ProviderHalt ? error.code : (error?.code ?? HaltReason.ACCESS_RESTRICTED);
    const target = HALT_REASON_TO_JOB_STATE[reason] ?? JobState.FAILED;
    this.#setState(target, {
      message: safeScreenText(error?.message ?? String(error), 200),
      haltReason: reason,
    });
  }

  async #run() {
    try {
      this.#setState(JobState.LAUNCHING_BROWSER, { message: "브라우저를 실행합니다." });
      await this.#provider.openBookingSite();

      this.#setState(JobState.WAITING_MANUAL_LOGIN, {
        message: "브라우저에서 직접 로그인한 뒤 RailFlow에서 '로그인 완료'를 눌러 주세요.",
      });
      await this.#provider.waitForManualLogin({
        timeoutMs: MANUAL_LOGIN_TIMEOUT_MINUTES * 60 * 1000,
        isConfirmedByUser: () => this.#loginConfirmed,
      });
      if (this.#checkStop()) return;

      this.#setState(JobState.CONNECTED, { message: "로그인을 확인했습니다." });
      await this.#watchLoop();
    } catch (error) {
      if (this.#job && !isTerminal(this.#job.state)) this.#halt(error);
      else log.error("작업 실패", { error });
    } finally {
      await this.#provider.stop().catch(() => {});
    }
  }

  #checkStop() {
    if (!this.#stopRequested) return false;
    const target = resolveUserStopTarget(this.#job.state);
    if (target === JobState.STOPPED_BY_USER) {
      this.#setState(JobState.STOPPED_BY_USER, {
        message: "사용자 요청으로 중단했습니다. 예약 요청을 보낸 적은 없습니다.",
      });
      return true;
    }
    return false;
  }

  async #watchLoop() {
    let backoffIndex = -1;
    while (!isTerminal(this.#job.state)) {
      if (this.#checkStop()) return;

      let progressed = false;
      for (const candidate of this.#job.candidates) {
        if (isTerminal(this.#job.state)) return;
        if (this.#checkStop()) return;
        if (candidate.state === "STOPPED" || candidate.state === "RESERVED") continue;

        try {
          await this.#checkOneCandidate(candidate);
          backoffIndex = -1;
          progressed = true;
        } catch (error) {
          if (error instanceof ProviderHalt) {
            this.#halt(error);
            return;
          }
          // 상태 전이 오류는 코드 결함이지 네트워크 장애가 아니다.
          // 재시도로 덮지 않고 그대로 드러낸다.
          if (error?.code === "INVALID_TRANSITION") {
            log.error("상태 전이 오류", { error });
            this.#job.state = JobState.FAILED;
            this.#job.haltReason = "INVALID_TRANSITION";
            this.#job.message = String(error.message);
            this.#emit();
            return;
          }
          // 네트워크 계열 장애만 백오프한다. 상한을 넘으면 중단한다.
          backoffIndex += 1;
          if (backoffIndex >= NETWORK_BACKOFF_SECONDS.length) {
            this.#halt({ code: HaltReason.NETWORK_BACKOFF_EXHAUSTED, message: String(error?.message ?? error) });
            return;
          }
          const wait = NETWORK_BACKOFF_SECONDS[backoffIndex];
          log.warn("조회 실패. 백오프 후 다시 시도합니다.", { waitSeconds: wait, error });
          await sleep(wait * 1000);
        }
      }

      if (isTerminal(this.#job.state)) return;
      const allDone = this.#job.candidates.every((c) => c.state === "STOPPED" || c.state === "RESERVED");
      if (allDone) {
        this.#setState(JobState.STOPPED_BY_USER, { message: "확인할 후보가 남아 있지 않습니다." });
        return;
      }
      if (progressed) {
        // 고정 주기. 탐지 회피용 무작위화는 하지 않는다.
        // 다만 사용자가 중단을 누르면 주기가 끝나기를 기다리지 않고 바로 멈춘다.
        await this.#waitBetweenChecks(this.#config.livePollingIntervalSeconds * 1000);
      }
    }
  }

  async #checkOneCandidate(candidate) {
    const { condition } = this.#job;

    if (candidate.rowIndex == null) {
      this.#setState(JobState.SEARCHING_TRAIN, {
        message: `${candidate.trainNumber} 열차를 화면에서 찾는 중입니다.`,
      });
      const found = await this.#provider.searchTrain({
        departure: condition.departure,
        arrival: condition.arrival,
        date: condition.date,
        passengers: condition.passengers,
        candidate,
      });
      candidate.rowIndex = found.rowIndex;
      this.#setState(JobState.TRAIN_CONFIRMED, {
        message: `${candidate.trainNumber} 열차를 확인했습니다.`,
      });
    }

    const reading = await this.#provider.readSeatAvailability({ rowIndex: candidate.rowIndex });
    candidate.checkCount += 1;
    candidate.checkedAt = new Date().toISOString();
    candidate.lastSeatStatus = reading.status;
    candidate.lastScreenText = reading.screenText;
    this.#job.checkCount += 1;

    if (SEAT_STATUS_HALT.includes(reading.status)) {
      this.#setState(SEAT_STATUS_TO_JOB_STATE[reading.status], {
        message: `화면 상태: ${reading.screenText}`,
        haltReason:
          reading.status === SeatStatus.AUTH_REQUIRED ? HaltReason.LOGIN_EXPIRED : HaltReason.ACCESS_RESTRICTED,
      });
      return;
    }

    // 읽기 실패·알 수 없음은 매진으로 취급하지 않는다. 다음 주기에 다시 본다.
    if (reading.status === SeatStatus.UNKNOWN) {
      candidate.state = "WATCHING";
      this.#setState(JobState.WATCHING_SOLD_OUT, {
        message: `${candidate.trainNumber}: 좌석 상태를 읽지 못했습니다(매진으로 처리하지 않습니다).`,
      });
      return;
    }

    if (!seatStatusSatisfies(condition.seatPreference, reading.status)) {
      candidate.state = "WATCHING";
      this.#setState(JobState.WATCHING_SOLD_OUT, {
        message: `${candidate.trainNumber}: ${reading.screenText}`,
      });
      return;
    }

    // 조건을 만족하는 좌석을 찾았다.
    candidate.state = "SEAT_FOUND";
    this.#setState(JobState.SEAT_FOUND, {
      message: `${candidate.trainNumber}: 조건을 만족하는 좌석이 화면에 표시됐습니다.`,
    });

    if (this.#job.mode !== RunMode.LIVE_RESERVATION_ARMED) {
      // 읽기 전용 모드에서는 여기서 멈춘다. 예약 버튼은 누르지 않는다.
      this.#setState(JobState.AWAITING_ARM_CONFIRMATION, {
        message:
          "읽기 전용 모드입니다. 실제 예약을 진행하려면 RailFlow에서 조건을 확인하고 예약을 승인해 주세요.",
      });
      // 승인을 기다리는 동안에는 공식 사이트를 다시 조회하지 않는다.
      const armed = await this.#waitForArm();
      if (!armed) return;
    }

    await this.#reserve(candidate);
  }

  /**
   * 다음 조회까지 기다린다. 주기 자체는 고정이지만, 기다리는 도중에
   * 사용자가 중단하면 즉시 빠져나온다 -- 중단이 최대 한 주기만큼 늦게
   * 먹히면 안 되기 때문이다.
   */
  async #waitBetweenChecks(totalMs) {
    const step = 200;
    for (let waited = 0; waited < totalMs; waited += step) {
      if (this.#stopRequested || isTerminal(this.#job.state)) return;
      await sleep(Math.min(step, totalMs - waited));
    }
  }

  /**
   * 사용자의 예약 승인을 기다린다. 이 동안에는 공식 사이트로 아무 요청도
   * 보내지 않는다. 사용자가 중단하면 false 를 돌려준다.
   */
  async #waitForArm() {
    while (!this.#armConfirmed) {
      if (this.#stopRequested) {
        this.#setState(JobState.STOPPED_BY_USER, {
          message: "승인 대기 중에 사용자가 중단했습니다. 예약 요청을 보낸 적은 없습니다.",
        });
        return false;
      }
      if (isTerminal(this.#job.state)) return false;
      await sleep(300);
    }
    return true;
  }

  async #reserve(candidate) {
    const { condition } = this.#job;

    // 1) 같은 조건의 기존 예약이 이미 있는지 먼저 확인한다.
    const existing = await this.#provider.verifyReservation({
      candidate: { ...candidate, departure: condition.departure, arrival: condition.arrival },
      date: condition.date,
    });
    if (existing.confirmed) {
      this.#job.reservation = { ...existing, source: "existing" };
      this.#stopOtherCandidates(candidate.id);
      this.#setState(JobState.RECONCILIATION_REQUIRED, {
        message: "같은 조건의 예약이 이미 있습니다. 중복 예약을 피하기 위해 중단합니다.",
        haltReason: HaltReason.EXISTING_RESERVATION_FOUND,
      });
      return;
    }

    // 2) 예약 요청 직전에 좌석 상태를 한 번 더 확인한다.
    const recheck = await this.#provider.readSeatAvailability({ rowIndex: candidate.rowIndex });
    if (!seatStatusSatisfies(condition.seatPreference, recheck.status)) {
      candidate.state = "WATCHING";
      candidate.lastSeatStatus = recheck.status;
      candidate.lastScreenText = recheck.screenText;
      this.#setState(JobState.WATCHING_SOLD_OUT, {
        message: `예약 직전 재확인에서 조건을 만족하지 않았습니다: ${recheck.screenText}`,
      });
      return;
    }

    // 3) 펜싱 토큰 확인 후 단 한 번 클릭한다.
    this.#setState(JobState.RESERVING, { message: `${candidate.trainNumber} 예약을 요청합니다.` });
    let clicked = null;
    try {
      clicked = await this.#provider.requestReservation({ rowIndex: candidate.rowIndex });
    } catch (error) {
      if (error instanceof ProviderHalt) throw error;
      // 클릭 자체가 실패했는지, 클릭 후 응답만 실패했는지 알 수 없다.
      // 다시 누르지 않고 예약내역으로 확인하러 간다.
      log.warn("예약 요청 중 오류. 재클릭하지 않고 결과를 확인합니다.", { error });
    }

    // 4) 눌렀다는 사실만으로 성공 처리하지 않는다. 예약내역에서 확인한다.
    this.#setState(JobState.VERIFYING_RESERVATION, { message: "예약 결과를 확인하는 중입니다." });
    const verified = await this.#provider.verifyReservation({
      candidate: { ...candidate, departure: condition.departure, arrival: condition.arrival },
      date: condition.date,
    });

    if (!verified.confirmed) {
      this.#job.reservation = { confirmed: false, clicked: Boolean(clicked), ...verified };
      this.#setState(JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED, {
        message:
          "예약 버튼을 눌렀지만 예약내역에서 확인하지 못했습니다. 다시 누르지 않았습니다. 공식 예매 화면에서 직접 확인해 주세요.",
        haltReason: HaltReason.RESERVATION_RESULT_UNCERTAIN,
      });
      return;
    }

    // 5) 결제기한은 화면에서 읽은 값만 쓴다. 못 읽으면 표시하지 않는다.
    const deadline = await this.#provider.readPaymentDeadline();
    candidate.state = "RESERVED";
    this.#job.reservation = {
      confirmed: true,
      source: "reservationList",
      trainNumber: candidate.trainNumber,
      departAt: candidate.departAt,
      arriveAt: candidate.arriveAt,
      departure: condition.departure,
      arrival: condition.arrival,
      date: condition.date,
      passengers: condition.passengers,
      seatPreference: condition.seatPreference,
      reservationNumber: verified.reservationNumber ?? null,
      paymentDeadline: deadline.found ? { iso: deadline.iso, label: deadline.label, rawText: deadline.rawText } : null,
      evidence: verified.evidence,
      verifiedAt: new Date().toISOString(),
    };
    this.#stopOtherCandidates(candidate.id);
    this.#setState(JobState.RESERVED_PAYMENT_REQUIRED, {
      message: deadline.found
        ? "예약이 확인됐습니다. 결제는 공식 예매 서비스에서 직접 진행해 주세요."
        : "예약이 확인됐습니다. 결제기한은 화면에서 확인하지 못했습니다(추정값을 표시하지 않습니다).",
    });
  }

  /** 예약이 확인되면 나머지 후보 감시를 즉시 멈춘다(지침 §10). */
  #stopOtherCandidates(keepId) {
    for (const candidate of this.#job.candidates) {
      if (candidate.id !== keepId && candidate.state !== "RESERVED") {
        candidate.state = "STOPPED";
      }
    }
    log.info("나머지 후보 감시를 중단했습니다.", { keepId });
  }
}
