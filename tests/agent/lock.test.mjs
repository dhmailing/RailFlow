import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLock, LockError } from "../../agent/src/lock.mjs";

function tmpLock() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "railflow-lock-")), "agent.lock");
}

test("두 번째 실행은 잠금을 빼앗지 못한다", () => {
  const file = tmpLock();
  const first = new AgentLock(file);
  first.acquire();
  const second = new AgentLock(file);
  // 첫 번째가 이 프로세스라서 pid 가 같으면 통과해 버리므로, 살아있는
  // 다른 프로세스가 잡고 있는 상황을 파일로 직접 만든다.
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: 1, fencingToken: 999, acquiredAt: Date.now(), heartbeatAt: Date.now() }),
  );
  assert.throws(() => second.acquire(), LockError);
});

test("죽은 잠금은 이어받되 펜싱 토큰은 반드시 커진다", () => {
  const file = tmpLock();
  const stale = Date.now() - 10 * 60 * 1000;
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: 999999, fencingToken: 42, acquiredAt: stale, heartbeatAt: stale }),
  );
  const lock = new AgentLock(file);
  const token = lock.acquire();
  assert.ok(token > 42, "펜싱 토큰이 이전 값보다 커야 한다");
});

test("더 최신 실행이 나타나면 예약 동작을 막는다", () => {
  const file = tmpLock();
  const lock = new AgentLock(file);
  lock.acquire();
  assert.equal(lock.assertFencingToken(), true);

  // 다른 실행이 잠금을 새로 잡은 상황.
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...current, fencingToken: current.fencingToken + 1 }));

  assert.throws(() => lock.assertFencingToken(), /예약 동작을 중단/);
});

test("잠금 파일이 사라지면 예약 동작을 막는다", () => {
  const file = tmpLock();
  const lock = new AgentLock(file);
  lock.acquire();
  fs.unlinkSync(file);
  assert.throws(() => lock.assertFencingToken(), LockError);
});

test("해제는 자기 토큰일 때만 파일을 지운다", () => {
  const file = tmpLock();
  const lock = new AgentLock(file);
  lock.acquire();
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...current, fencingToken: current.fencingToken + 5 }));
  lock.release();
  assert.equal(fs.existsSync(file), true, "남의 잠금을 지우면 안 된다");
});
