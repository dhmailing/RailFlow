// LIVE_READ_ONLY 실증 흐름.
//
// 지침 §9의 순서를 그대로 코드로 옮겼다. 캡처 직후에 곧바로 반복 감시로
// 들어가지 않는다.
//
//   1) 단건 열차 검색
//   2) 단건 좌석 상태 읽기
//   3) 같은 열차 재조회 1회
//   4) 두 번의 해석이 일관된지 확인
//   5) 그 뒤에만 60초 고정 주기 감시
//
// 예약 버튼은 이 흐름 어디에서도 누르지 않는다. Provider 자체가 읽기 전용
// (allowReservation=false)으로 만들어지므로 호출해도 동작하지 않는다.

import { MIN_LIVE_POLLING_INTERVAL_SECONDS, DEFAULT_LIVE_POLLING_INTERVAL_SECONDS, MANUAL_LOGIN_TIMEOUT_MINUTES, NETWORK_BACKOFF_SECONDS } from "./config.mjs";
import { log } from "./log.mjs";
import { redactValue } from "./redact.mjs";
import { JobState, SeatStatus, HaltReason, SEAT_STATUS_HALT, TERMINAL_JOB_STATES } from "./status.mjs";
import { normalizeTime, normalizeTrainNumber } from "./match.mjs";
import { ProviderHalt } from "./providers/provider-halt.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  [HaltReason.PROFILE_FINGERPRINT_MISMATCH]: JobState.PROVIDER_CHANGED,
  [HaltReason.PROFILE_TAMPERED]: JobState.PROVIDER_CHANGED,
  [HaltReason.TRAIN_IDENTIFICATION_UNCERTAIN]: JobState.PROVIDER_CHANGED,
  [HaltReason.UNEXPECTED_PAYMENT_SCREEN]: JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  [HaltReason.UNEXPECTED_RESERVATION_SCREEN]: JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  [HaltReason.RESERVATION_NOT_ARMED]: JobState.FAILED,
  [HaltReason.HOST_NOT_ALLOWED]: JobState.FAILED,
  [HaltReason.NETWORK_BACKOFF_EXHAUSTED]: JobState.FAILED,
});

export class ReadOnlyProbe {
  #provider;
  #listeners = new Set();
  #state = JobState.IDLE;
  #haltReason = null;
  #message = null;
  #loginConfirmed = false;
  #stopRequested = false;
  #condition = null;
  #candidate = null;
  #rowIndex = null;
  #readings = [];
  #phase = "IDLE";
  #pollingIntervalSeconds = DEFAULT_LIVE_POLLING_INTERVAL_SECONDS;
  #loop = null;

  constructor({ provider, pollingIntervalSeconds = DEFAULT_LIVE_POLLING_INTERVAL_SECONDS }) {
    if (provider.reservationEnabled) {
      throw new Error("읽기 전용 실증에는 예약이 가능한 Provider를 쓸 수 없습니다.");
    }
    this.#provider = provider;
    this.#pollingIntervalSeconds = Math.max(
      MIN_LIVE_POLLING_INTERVAL_SECONDS,
      Number(pollingIntervalSeconds) || DEFAULT_LIVE_POLLING_INTERVAL_SECONDS,
    );
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    const snap = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snap);
      } catch (error) {
        log.warn("상태 구독자 오류", { error });
      }
    }
  }

  snapshot() {
    return redactValue({
      mode: "LIVE_READ_ONLY",
      // 이 값이 false 라는 것이 "예약 코드가 호출될 수 없다"의 근거다.
      reservationEnabled: false,
      provider: {
        name: this.#provider.name,
        operator: this.#provider.operator,
        host: this.#provider.host,
        simulation: false,
      },
      phase: this.#phase,
      state: this.#state,
      haltReason: this.#haltReason,
      message: this.#message,
      pollingIntervalSeconds: this.#pollingIntervalSeconds,
      condition: this.#condition,
      candidate: this.#candidate,
      // 실제 화면에서 읽은 것만 들어간다. 없으면 빈 배열이다.
      readings: this.#readings,
      active: !TERMINAL_JOB_STATES.includes(this.#state),
    });
  }

  #set(state, { message = null, haltReason = null, phase = null } = {}) {
    this.#state = state;
    this.#message = message;
    this.#haltReason = haltReason;
    if (phase) this.#phase = phase;
    log.info("읽기 전용 상태 변경", { state, phase: this.#phase, haltReason });
    this.#emit();
  }

  confirmLogin() {
    this.#loginConfirmed = true;
    this.#emit();
  }

  requestStop() {
    this.#stopRequested = true;
    log.info("사용자가 중단을 요청했습니다.");
    this.#emit();
  }

  /**
   * 실증 시작. 후보 열차는 한 편이다 -- 이번 단계의 목표가 "한 건 이상
   * 실제로 읽는 것"이기 때문이다.
   */
  async start({ departure, arrival, date, passengers, seatPreference, candidate }) {
    if (this.#loop) throw new Error("이미 실행 중입니다.");
    this.#condition = { departure, arrival, date, passengers, seatPreference: seatPreference ?? "any" };
    this.#candidate = candidate;
    this.#readings = [];
    this.#stopRequested = false;
    this.#loginConfirmed = false;
    this.#loop = this.#run().catch((error) => log.error("읽기 전용 흐름이 예기치 않게 끝났습니다.", { error }));
    return this.snapshot();
  }

  async waitUntilIdle() {
    if (this.#loop) await this.#loop;
  }

  #halt(error) {
    const reason = error instanceof ProviderHalt ? error.code : (error?.code ?? HaltReason.ACCESS_RESTRICTED);
    this.#set(HALT_REASON_TO_JOB_STATE[reason] ?? JobState.FAILED, {
      message: String(error?.message ?? error).slice(0, 300),
      haltReason: reason,
    });
  }

  #checkStop() {
    if (!this.#stopRequested) return false;
    this.#set(JobState.STOPPED_BY_USER, {
      message: "사용자 요청으로 중단했습니다. 예약 동작은 수행하지 않았습니다.",
      phase: "STOPPED",
    });
    return true;
  }

  async #run() {
    try {
      this.#set(JobState.LAUNCHING_BROWSER, { message: "브라우저를 실행합니다.", phase: "OPEN" });
      await this.#provider.openBookingSite();

      this.#set(JobState.WAITING_MANUAL_LOGIN, {
        message: "열린 브라우저에서 직접 로그인한 뒤 [로그인 완료] 를 눌러 주세요.",
        phase: "LOGIN",
      });
      await this.#provider.waitForManualLogin({
        timeoutMs: MANUAL_LOGIN_TIMEOUT_MINUTES * 60 * 1000,
        isConfirmedByUser: () => this.#loginConfirmed,
      });
      if (this.#checkStop()) return;
      this.#set(JobState.CONNECTED, { message: "로그인을 확인했습니다.", phase: "CONNECTED" });

      // 1) 단건 검색
      this.#set(JobState.SEARCHING_TRAIN, {
        message: `${this.#candidate.trainNumber} 열차를 조회합니다.`,
        phase: "SINGLE_SEARCH",
      });
      const found = await this.#provider.searchTrain({ ...this.#condition, candidate: this.#candidate });
      this.#rowIndex = found.rowIndex;
      this.#set(JobState.TRAIN_CONFIRMED, { message: "열차를 확인했습니다.", phase: "SINGLE_SEARCH" });
      if (this.#checkStop()) return;

      // 2) 단건 읽기
      this.#phase = "SINGLE_READ";
      const first = await this.#readOnce("1회차");
      if (this.#state !== JobState.TRAIN_CONFIRMED && TERMINAL_JOB_STATES.includes(this.#state)) return;
      if (this.#checkStop()) return;

      // 3) 같은 열차 재조회 1회
      this.#phase = "RECHECK";
      this.#set(JobState.WATCHING_SOLD_OUT, { message: "같은 열차를 한 번 더 읽어 확인합니다.", phase: "RECHECK" });
      const second = await this.#readOnce("2회차");
      if (TERMINAL_JOB_STATES.includes(this.#state)) return;
      if (this.#checkStop()) return;

      // 4) 일관성 확인
      const consistent = this.#checkConsistency(first, second);
      if (!consistent.ok) {
        this.#set(JobState.PROVIDER_CHANGED, {
          message: `두 번의 조회가 일관되게 해석되지 않았습니다: ${consistent.reason}`,
          haltReason: HaltReason.TRAIN_IDENTIFICATION_UNCERTAIN,
          phase: "RECHECK",
        });
        return;
      }
      this.#set(JobState.WATCHING_SOLD_OUT, {
        message: `실제 좌석 상태를 두 번 일관되게 읽었습니다. 이제 ${this.#pollingIntervalSeconds}초 고정 주기로 감시합니다.`,
        phase: "POLLING",
      });

      // 5) 고정 주기 감시
      await this.#pollLoop();
    } catch (error) {
      if (!TERMINAL_JOB_STATES.includes(this.#state)) this.#halt(error);
      else log.error("읽기 전용 실패", { error });
    } finally {
      await this.#provider.stop().catch(() => {});
    }
  }

  /** 한 번 읽고 기록한다. 중단 신호면 상태를 바꾼다. */
  async #readOnce(label) {
    const reading = await this.#provider.readSeatAvailability({
      rowIndex: this.#rowIndex,
      seatPreference: this.#condition.seatPreference,
    });

    const record = {
      label,
      readAt: reading.readAt,
      sourceHost: reading.sourceHost ?? this.#provider.host,
      trainType: this.#candidate.trainType ?? null,
      trainNumber: reading.trainNumber || this.#candidate.trainNumber,
      date: this.#condition.date,
      departAt: reading.departAt || this.#candidate.departAt,
      arriveAt: reading.arriveAt || this.#candidate.arriveAt,
      departure: this.#condition.departure,
      arrival: this.#condition.arrival,
      // 등급별 원본 문구를 그대로 보존한다.
      standardScreenText: reading.standard?.screenText ?? null,
      firstScreenText: reading.first?.screenText ?? null,
      standardStatus: reading.standard?.status ?? null,
      firstStatus: reading.first?.status ?? null,
      status: reading.status,
    };
    this.#readings.push(record);
    this.#emit();

    if (SEAT_STATUS_HALT.includes(reading.status)) {
      this.#set(SEAT_STATUS_TO_JOB_STATE[reading.status], {
        message: `화면 상태: ${reading.screenText}`,
        haltReason:
          reading.status === SeatStatus.AUTH_REQUIRED ? HaltReason.LOGIN_EXPIRED : HaltReason.ACCESS_RESTRICTED,
      });
    }
    return record;
  }

  /**
   * 두 번의 읽기가 같은 열차를 같은 자리에서 읽었는지 확인한다.
   * 좌석 상태 자체는 바뀔 수 있으므로 비교하지 않는다 -- 바뀌는 게 정상이다.
   */
  #checkConsistency(a, b) {
    if (normalizeTrainNumber(a.trainNumber) !== normalizeTrainNumber(b.trainNumber)) {
      return { ok: false, reason: "두 번의 조회에서 열차번호가 다릅니다." };
    }
    if (normalizeTime(a.departAt) !== normalizeTime(b.departAt)) {
      return { ok: false, reason: "두 번의 조회에서 출발시각이 다릅니다." };
    }
    if (a.status === SeatStatus.UNKNOWN && b.status === SeatStatus.UNKNOWN) {
      return { ok: false, reason: "두 번 모두 좌석 상태 문구를 해석하지 못했습니다(매진으로 처리하지 않습니다)." };
    }
    return { ok: true };
  }

  async #pollLoop() {
    let backoffIndex = -1;
    while (!TERMINAL_JOB_STATES.includes(this.#state)) {
      await this.#waitBetweenChecks(this.#pollingIntervalSeconds * 1000);
      if (this.#checkStop()) return;
      if (TERMINAL_JOB_STATES.includes(this.#state)) return;
      try {
        await this.#readOnce(`${this.#readings.length + 1}회차`);
        backoffIndex = -1;
      } catch (error) {
        if (error instanceof ProviderHalt) {
          this.#halt(error);
          return;
        }
        backoffIndex += 1;
        if (backoffIndex >= NETWORK_BACKOFF_SECONDS.length) {
          this.#halt({ code: HaltReason.NETWORK_BACKOFF_EXHAUSTED, message: String(error?.message ?? error) });
          return;
        }
        const wait = NETWORK_BACKOFF_SECONDS[backoffIndex];
        log.warn("조회 실패. 백오프 후 다시 시도합니다.", { waitSeconds: wait, error });
        await this.#waitBetweenChecks(wait * 1000);
      }
    }
  }

  /** 고정 주기지만, 중단은 주기가 끝나기를 기다리지 않는다. */
  async #waitBetweenChecks(totalMs) {
    const step = 200;
    for (let waited = 0; waited < totalMs; waited += step) {
      if (this.#stopRequested || TERMINAL_JOB_STATES.includes(this.#state)) return;
      await sleep(Math.min(step, totalMs - waited));
    }
  }
}
