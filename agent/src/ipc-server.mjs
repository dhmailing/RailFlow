// RailFlow 웹 UI <-> 로컬 Agent 통신.
//
// 127.0.0.1 에만 바인딩한다. 외부에서 접근할 수 없다.
//
// 페어링 토큰: Agent를 실행하면 콘솔에 6자리 코드가 찍힌다. 사용자가 그
// 코드를 RailFlow 화면에 입력해야 명령이 통한다. 브라우저에서 열린 아무
// 페이지나 로컬 Agent에 예약을 시키지 못하게 하는 최소한의 장치다.
// 이 토큰은 실행할 때마다 새로 만들어지고 파일로 저장하지 않는다.

import http from "node:http";
import crypto from "node:crypto";
import { log } from "./log.mjs";
import { redactValue } from "./redact.mjs";

/** RailFlow 웹 UI가 열려 있을 수 있는 로컬 주소만 허용한다. */
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("요청이 너무 큽니다."));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function startIpcServer({ port, runner, pairingToken = crypto.randomBytes(3).toString("hex") }) {
  const subscribers = new Set();

  const applyCors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGIN.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-railflow-agent-token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    res.setHeader("Cache-Control", "no-store");
  };

  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(redactValue(payload)));
  };

  const authorized = (req) => req.headers["x-railflow-agent-token"] === pairingToken;

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");

    // 연결 확인용. 토큰 없이도 "Agent가 떠 있다"까지만 알려준다.
    if (req.method === "GET" && url.pathname === "/ping") {
      send(res, 200, { ok: true, agent: "railflow-local-agent", requiresToken: true });
      return;
    }

    if (!authorized(req)) {
      send(res, 401, { error: "PAIRING_REQUIRED", message: "Agent 콘솔에 표시된 연결 코드를 입력해 주세요." });
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/status") {
        send(res, 200, runner.snapshot());
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "cache-control": "no-store",
        });
        const push = (snapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        push(runner.snapshot());
        const off = runner.onChange(push);
        subscribers.add(res);
        req.on("close", () => {
          off();
          subscribers.delete(res);
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs") {
        const body = await readJson(req);
        const id = await runner.start(body);
        send(res, 201, { id, status: runner.snapshot() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/confirm-login") {
        runner.confirmLogin();
        send(res, 200, runner.snapshot());
        return;
      }

      // 실제 예약 승인. 승인 화면이 보여준 조건을 그대로 되돌려 받아
      // 실행 중인 작업과 대조한다.
      if (req.method === "POST" && url.pathname === "/jobs/arm") {
        const body = await readJson(req);
        runner.confirmArm(body);
        send(res, 200, runner.snapshot());
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/stop") {
        runner.requestStop();
        send(res, 200, runner.snapshot());
        return;
      }

      send(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      log.warn("IPC 요청 처리 실패", { path: url.pathname, error });
      send(res, 400, { error: "BAD_REQUEST", message: String(error?.message ?? error) });
    }
  });

  return new Promise((resolve) => {
    // 127.0.0.1 고정. 0.0.0.0 으로 열지 않는다.
    server.listen(port, "127.0.0.1", () => {
      log.info("로컬 Agent 서버를 시작했습니다.", { url: `http://127.0.0.1:${port}` });
      resolve({
        server,
        port,
        pairingToken,
        close: () =>
          new Promise((done) => {
            for (const res of subscribers) res.end();
            subscribers.clear();
            server.close(done);
          }),
      });
    });
  });
}
