// 실사이트 자동화 차단(DEPRECATED_BLOCKED) 테스트.
//
// 확인하는 것: 실사이트로 나가는 모든 입구가 막혔는가, 설정으로 되살릴 수
// 있는 경로가 없는가, 이미 설치된 Agent도 업데이트되면 멈추는가.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-dep-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { Controller } = await import("../../agent/src/controller.mjs");
const { CaptureSession } = await import("../../agent/src/capture.mjs");
const { createLiveBookingProvider } = await import("../../agent/src/providers/live-booking-provider.mjs");
const { LiveAutomationBlockedError, LIVE_AUTOMATION_STATUS, liveAutomationStatus } = await import(
  "../../agent/src/deprecation.mjs"
);
const { closeLog } = await import("../../agent/src/log.mjs");

test.after(async () => { await closeLog(); });

const controller = new Controller({ config: { port: 4319, livePollingIntervalSeconds: 60 } });

/** 실사이트로 나가던 라우트 전부. 하나라도 통과하면 안 된다. */
const LIVE_ROUTES = [
  ["POST", "/api/capture/start"],
  ["POST", "/api/capture/login"],
  ["POST", "/api/capture/search"],
  ["POST", "/api/capture/await-pick"],
  ["POST", "/api/capture/skip"],
  ["GET", "/api/capture/observed"],
  ["POST", "/api/capture/reservation-list"],
  ["POST", "/api/capture/verify"],
  ["POST", "/api/probe/start"],
  ["POST", "/api/probe/login"],
  ["POST", "/api/probe/stop"],
];

test("실사이트로 나가던 모든 라우트가 차단된다", async () => {
  for (const [method, pathname] of LIVE_ROUTES) {
    await assert.rejects(
      () => controller.handle(pathname, method, {}),
      (error) => {
        assert.ok(error instanceof LiveAutomationBlockedError, `${pathname} 가 다른 오류를 냈다`);
        assert.equal(error.code, LIVE_AUTOMATION_STATUS);
        return true;
      },
      `${method} ${pathname} 가 통과했다`,
    );
  }
});

test("상태·진단은 여전히 볼 수 있고 차단 사실을 드러낸다", async () => {
  const state = await controller.handle("/api/state", "GET", {});
  assert.equal(state.liveAutomation.status, LIVE_AUTOMATION_STATUS);
  assert.equal(state.liveAutomation.canBeEnabled, false);
  assert.equal(state.capture, null);
  assert.equal(state.probe, null);

  const diagnostics = await controller.handle("/api/diagnostics", "GET", {});
  assert.equal(diagnostics.agent.liveAutomationEnabled, false);
  assert.equal(diagnostics.agent.reservationEnabled, false);
  assert.equal(diagnostics.liveAutomation.status, LIVE_AUTOMATION_STATUS);
});

test("예약·구매·결제 라우트는 여전히 존재하지 않는다", async () => {
  for (const pathname of ["/api/reserve", "/api/purchase", "/api/payment", "/api/probe/arm"]) {
    assert.equal(await controller.handle(pathname, "POST", {}), undefined, `${pathname} 가 존재한다`);
  }
});

test("환경변수로 되살릴 수 있는 스위치가 없다", () => {
  // 어떤 값을 넣어도 상태가 바뀌지 않아야 한다.
  const before = liveAutomationStatus().status;
  for (const name of [
    "RAILFLOW_ALLOW_LIVE",
    "RAILFLOW_ENABLE_LIVE_AUTOMATION",
    "ALLOW_LIVE_AUTOMATION",
    "RAILFLOW_LIVE",
  ]) {
    process.env[name] = "true";
  }
  assert.equal(liveAutomationStatus().status, before);
  assert.equal(liveAutomationStatus().canBeEnabled, false);
  for (const name of ["RAILFLOW_ALLOW_LIVE", "RAILFLOW_ENABLE_LIVE_AUTOMATION", "ALLOW_LIVE_AUTOMATION", "RAILFLOW_LIVE"]) {
    delete process.env[name];
  }

  // 소스에도 켜는 값이 없어야 한다.
  const source = fs.readFileSync(new URL("../../agent/src/deprecation.mjs", import.meta.url), "utf8");
  assert.ok(!/process\.env/.test(source), "차단 스위치가 환경변수를 읽는다");
});

test("Provider가 브라우저를 여는 순간 차단된다", async () => {
  const provider = createLiveBookingProvider({
    profile: {
      host: "example.test",
      operator: "테스트",
      allowedHosts: ["example.test"],
      pages: { search: { url: "https://example.test/s" }, reservationList: { url: "https://example.test/r" } },
      row: { containerTag: "tr", cellCount: 3, fieldPaths: {} },
      form: {},
      detectors: {},
      guardMarkers: {},
      fingerprint: "x",
    },
    playwright: {
      chromium: {
        launchPersistentContext: async () => {
          throw new Error("브라우저가 실제로 실행됐다");
        },
      },
    },
    lock: { assertFencingToken: () => true },
    allowReservation: false,
  });
  assert.equal(provider.lifecycle, LIVE_AUTOMATION_STATUS);
  await assert.rejects(() => provider.openBookingSite(), LiveAutomationBlockedError);
});

test("캡처 마법사도 화면을 열기 전에 차단된다", async () => {
  const session = new CaptureSession({
    playwright: {
      chromium: {
        launchPersistentContext: async () => {
          throw new Error("브라우저가 실제로 실행됐다");
        },
      },
    },
    expectation: { departure: "동탄", arrival: "울산(통도사)" },
  });
  await assert.rejects(() => session.open("https://example.test/"), LiveAutomationBlockedError);
});

test("차단 안내가 사용자에게 보여줄 내용을 갖추고 있다", () => {
  const notice = liveAutomationStatus();
  assert.ok(notice.title.length > 0);
  assert.ok(notice.summary.includes("자동화된 요청"));
  assert.ok(notice.whatIsBlocked.length >= 3);
  assert.ok(notice.whatStillWorks.length >= 1);
  assert.match(notice.document, /POSTMORTEM/);
  // 우회를 암시하는 표현이 없어야 한다.
  const text = JSON.stringify(notice);
  for (const word of ["우회", "회피", "프록시", "VPN", "지문 위장"]) {
    assert.ok(!text.includes(word) || text.includes("되살리지 않습니다"), `우회를 암시한다: ${word}`);
  }
});

test("저장소에 차단 화면·Request ID 같은 식별 정보가 없다", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const suspicious = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|ts|tsx|md|json)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        // 차단 페이지가 흔히 남기는 식별자 형태.
        if (/Request\s*ID\s*[:=]\s*[A-Za-z0-9-]{8,}/i.test(text)) suspicious.push(full);
        if (/Ray\s*ID\s*[:=]\s*[a-f0-9]{12,}/i.test(text)) suspicious.push(full);
      }
    }
  };
  walk(path.join(root, "agent"));
  walk(path.join(root, "docs"));
  assert.deepEqual(suspicious, [], `식별 정보로 보이는 값이 있다: ${suspicious.join(", ")}`);
});
