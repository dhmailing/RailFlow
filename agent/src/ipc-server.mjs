// 로컬 서버 -- 화면과 API를 같은 출처에서 제공한다.
//
// 보안 경계
//  - 127.0.0.1 에만 바인딩한다. 0.0.0.0 으로 열지 않는다.
//  - Origin 헤더가 있고 우리 출처가 아니면 거부한다. 다른 사이트의
//    스크립트가 이 서버를 부르지 못하게 하는 핵심 방어다.
//  - 거기에 더해 토큰을 요구한다. 토큰은 이 서버가 내보내는 화면 안에만
//    들어 있고, 교차 출처에서는 응답을 읽을 수 없으므로 가져갈 수 없다.
//  - 토큰은 실행할 때마다 새로 만들고 파일로 저장하지 않는다.

import http from "node:http";
import crypto from "node:crypto";
import { log } from "./log.mjs";
import { redactValue } from "./redact.mjs";
import { consolePage } from "./console-page.mjs";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) reject(new Error("요청이 너무 큽니다."));
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

/**
 * @param {object} options
 * @param {number} options.port
 * @param {object} options.controller 캡처/조회 흐름을 담당하는 객체
 */
export function startIpcServer({ port, controller, token = crypto.randomBytes(8).toString("hex") }) {
  const selfOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const send = (res, status, payload) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // 이 서버의 응답이 다른 문서에 끼워지지 않게 한다.
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    res.end(JSON.stringify(redactValue(payload)));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // 화면. 토큰을 심어서 내보내므로 사용자가 코드를 외울 필요가 없다.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
      });
      res.end(consolePage({ token, port }));
      return;
    }

    // 브라우저가 자동으로 요청하는 파일. 토큰 검사 앞에서 조용히 처리한다.
    // 그러지 않으면 화면을 열 때마다 401 이 콘솔에 찍혀 진짜 오류를 가린다.
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }

    // 이 Agent 자신의 화면이 "살아있는지" 확인할 때만 쓴다. CORS 헤더를
    // 내보내지 않으므로 다른 출처(공개 배포본 포함)에서는 읽을 수 없다.
    // 그게 의도다 -- 실제 자동화 명령은 로컬 화면에서만 나와야 한다.
    if (req.method === "GET" && url.pathname === "/ping") {
      send(res, 200, { ok: true, agent: "railflow-local-agent", consoleUrl: `http://127.0.0.1:${port}/` });
      return;
    }

    // 교차 출처 차단. 브라우저가 붙여 주는 Origin 을 그대로 본다.
    const origin = req.headers.origin;
    if (origin && !selfOrigins.has(origin)) {
      send(res, 403, {
        error: "CROSS_ORIGIN_BLOCKED",
        message: "다른 사이트에서는 이 Agent를 호출할 수 없습니다. 로컬 RailFlow 화면을 사용해 주세요.",
      });
      return;
    }
    if (req.headers["x-railflow-agent-token"] !== token) {
      send(res, 401, {
        error: "PAIRING_REQUIRED",
        message: `이 Agent의 화면(http://127.0.0.1:${port}/)에서만 조작할 수 있습니다.`,
      });
      return;
    }

    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const result = await controller.handle(url.pathname, req.method, body);
      if (result === undefined) {
        send(res, 404, { error: "NOT_FOUND" });
        return;
      }
      send(res, req.method === "POST" && url.pathname === "/api/capture/start" ? 201 : 200, result);
    } catch (error) {
      log.warn("요청 처리 실패", { path: url.pathname, error });
      send(res, 400, { error: error.code ?? "BAD_REQUEST", message: String(error?.message ?? error) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const consoleUrl = `http://127.0.0.1:${port}/`;
      log.info("로컬 서버를 시작했습니다.", { url: consoleUrl });
      resolve({
        server,
        port,
        token,
        consoleUrl,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
