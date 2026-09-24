// 로컬 서버의 경계 테스트.
//
// 확인하는 것: 화면과 API가 같은 출처인가, 다른 출처는 막히는가,
// 토큰 없이는 조작할 수 없는가, 예약 관련 경로가 아예 없는가.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-ipc-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { startIpcServer } = await import("../../agent/src/ipc-server.mjs");
const { closeLog } = await import("../../agent/src/log.mjs");

const PORT = 4478;
const BASE = `http://127.0.0.1:${PORT}`;

/** 최소한의 컨트롤러. 어떤 경로가 존재하는지만 본다. */
const controller = {
  handle: async (pathname, method) => {
    if (pathname === "/api/state" && method === "GET") return { profiles: [], capture: null, probe: null };
    if (pathname === "/api/probe/start" && method === "POST") return { started: true };
    return undefined;
  },
};

let server;
test.before(async () => {
  server = await startIpcServer({ port: PORT, controller });
});
test.after(async () => {
  await server.close();
  await closeLog();
});

test("화면과 API가 같은 출처에서 제공된다", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  // 토큰이 화면에 심겨 있어 사용자가 코드를 외울 필요가 없다.
  assert.match(html, /const TOKEN = "[a-f0-9]+"/);
  // 절대 경로(같은 출처)로만 호출한다. 다른 호스트를 부르지 않는다.
  assert.ok(!/fetch\("https?:\/\//.test(html), "화면이 외부 주소를 호출한다");
});

test("토큰 없이는 조작할 수 없다", async () => {
  const res = await fetch(`${BASE}/api/state`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "PAIRING_REQUIRED");
});

test("다른 출처에서는 토큰이 맞아도 막힌다", async () => {
  for (const origin of ["https://rail-flow.vercel.app", "http://localhost:3000", "http://evil.test"]) {
    const res = await fetch(`${BASE}/api/state`, {
      headers: { origin, "x-railflow-agent-token": server.token },
    });
    assert.equal(res.status, 403, `${origin} 가 통과했다`);
    assert.equal((await res.json()).error, "CROSS_ORIGIN_BLOCKED");
  }
});

test("자기 출처 + 토큰이면 통과한다", async () => {
  for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) {
    const res = await fetch(`${BASE}/api/state`, {
      headers: { origin, "x-railflow-agent-token": server.token },
    });
    assert.equal(res.status, 200, `${origin} 가 막혔다`);
  }
});

test("CORS 허용 헤더를 내보내지 않는다", async () => {
  const res = await fetch(`${BASE}/ping`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  // 다른 문서에 끼워 넣지 못하게 한다.
  const page = await fetch(`${BASE}/`);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});

test("브라우저가 자동 요청하는 favicon 은 401 을 만들지 않는다", async () => {
  const res = await fetch(`${BASE}/favicon.ico`);
  assert.equal(res.status, 204);
});

test("예약·구매·결제 경로가 존재하지 않는다", async () => {
  const headers = { origin: `http://127.0.0.1:${PORT}`, "x-railflow-agent-token": server.token };
  for (const pathname of [
    "/api/probe/arm",
    "/api/probe/reserve",
    "/api/reserve",
    "/api/purchase",
    "/api/payment",
    "/api/capture/arm",
  ]) {
    const res = await fetch(`${BASE}${pathname}`, { method: "POST", headers, body: "{}" });
    assert.equal(res.status, 404, `${pathname} 가 존재한다`);
  }
});

test("응답은 캐시되지 않는다", async () => {
  const res = await fetch(`${BASE}/api/state`, {
    headers: { origin: `http://127.0.0.1:${PORT}`, "x-railflow-agent-token": server.token },
  });
  assert.equal(res.headers.get("cache-control"), "no-store");
});
