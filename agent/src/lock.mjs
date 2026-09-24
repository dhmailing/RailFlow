// 단일 실행 잠금 + 펜싱 토큰.
//
// 막으려는 것(지침 §10):
//  - 같은 PC에서 Agent를 두 번 띄워 같은 작업을 동시에 실행하는 것
//  - 오래된(정지된 줄 알았던) 실행이 뒤늦게 깨어나 예약 버튼을 누르는 것
//
// 펜싱 토큰은 단조 증가한다. 예약 클릭처럼 되돌릴 수 없는 동작 직전에
// 항상 assertFencingToken() 으로 자기 토큰이 아직 최신인지 확인한다.
// 최신이 아니면 클릭하지 않고 LOCK_LOST 로 중단한다.

import fs from "node:fs";
import path from "node:path";
import { lockFilePath } from "./config.mjs";

/** 잠금이 이 시간(ms) 넘게 갱신되지 않으면 죽은 것으로 본다. */
const LOCK_STALE_MS = 3 * 60 * 1000;

function readLockFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 다른 사용자의 살아있는 프로세스. 살아있는 것으로 본다.
    return error?.code === "EPERM";
  }
}

export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LockError";
    this.code = code;
  }
}

export class AgentLock {
  #file;
  #token;
  #heartbeat = null;

  constructor(file = lockFilePath()) {
    this.#file = file;
  }

  get fencingToken() {
    return this.#token;
  }

  /**
   * 잠금을 얻는다. 이미 살아있는 다른 실행이 있으면 실패한다 --
   * 강제로 빼앗지 않는다. 사용자가 그쪽을 먼저 끝내야 한다.
   */
  acquire({ now = Date.now() } = {}) {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const existing = readLockFile(this.#file);
    if (existing) {
      const fresh = now - Number(existing.heartbeatAt ?? 0) < LOCK_STALE_MS;
      if (fresh && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        throw new LockError(
          "ALREADY_RUNNING",
          `이미 실행 중인 RailFlow Agent가 있습니다(PID ${existing.pid}). 그쪽을 먼저 종료해 주세요.`,
        );
      }
    }
    // 펜싱 토큰은 기존 값보다 반드시 커진다. 파일이 지워졌다 다시 생겨도
    // 시계를 함께 써서 뒤로 돌아가지 않게 한다.
    this.#token = Math.max(Number(existing?.fencingToken ?? 0) + 1, now);
    this.#persist(now);
    return this.#token;
  }

  #persist(now) {
    const payload = {
      pid: process.pid,
      fencingToken: this.#token,
      acquiredAt: now,
      heartbeatAt: now,
    };
    fs.writeFileSync(this.#file, JSON.stringify(payload), "utf8");
  }

  /** 살아있음을 알린다. 장시간 감시 중에도 잠금이 죽은 것으로 오인되지 않게 한다. */
  heartbeat({ now = Date.now() } = {}) {
    const existing = readLockFile(this.#file);
    if (!existing || existing.fencingToken !== this.#token) {
      throw new LockError("LOCK_LOST", "잠금을 다른 실행이 가져갔습니다. 자동 동작을 중단합니다.");
    }
    fs.writeFileSync(
      this.#file,
      JSON.stringify({ ...existing, pid: process.pid, heartbeatAt: now }),
      "utf8",
    );
  }

  startHeartbeat(intervalMs = 30_000, onLost = () => {}) {
    this.stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      try {
        this.heartbeat();
      } catch (error) {
        this.stopHeartbeat();
        onLost(error);
      }
    }, intervalMs);
    this.#heartbeat.unref?.();
  }

  stopHeartbeat() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  /**
   * 되돌릴 수 없는 동작(예약 클릭) 직전에 호출한다.
   * 내 토큰이 더 이상 최신이 아니면 던진다 -- 그 경우 클릭하지 않는다.
   */
  assertFencingToken() {
    const existing = readLockFile(this.#file);
    if (!existing) {
      throw new LockError("LOCK_LOST", "잠금 파일이 사라졌습니다. 예약 동작을 중단합니다.");
    }
    if (existing.fencingToken !== this.#token) {
      throw new LockError(
        "LOCK_LOST",
        `더 최신 실행(토큰 ${existing.fencingToken})이 있습니다. 이 실행(토큰 ${this.#token})은 예약 동작을 중단합니다.`,
      );
    }
    return true;
  }

  release() {
    this.stopHeartbeat();
    const existing = readLockFile(this.#file);
    if (existing && existing.fencingToken === this.#token) {
      try {
        fs.unlinkSync(this.#file);
      } catch {
        /* 이미 지워졌으면 그만이다 */
      }
    }
  }
}
