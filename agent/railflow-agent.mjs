#!/usr/bin/env node
// RailFlow Local Automation Agent -- 실행 진입점.
//
// 이 프로그램은 사용자의 PC에서 돌아간다. Vercel 함수 안에서는 실행되지
// 않는다(브라우저와 로그인 세션을 유지할 수 없기 때문 -- 지침 §5).
//
// 명령
//   railflow-agent capture --url https://<공식 예매 화면 주소>
//       실제 화면을 열어 사이트 프로필 초안을 만든다.
//   railflow-agent check
//       프로필이 실행 가능한 상태인지 검사한다. 브라우저를 열지 않는다.
//   railflow-agent watch
//       RailFlow 웹 UI의 명령을 받는 로컬 서버를 띄운다. 실제 감시는
//       UI에서 "감시 시작"을 눌러야 시작된다.
//
// 중요: watch 로 띄워도 처음에는 항상 읽기 전용(LIVE_READ_ONLY)이다.
// 예약 버튼을 누르려면 UI에서 조건을 다시 확인하고 승인해야 한다.

import process from "node:process";
import readline from "node:readline";
import { resolveConfig, DEFAULT_AGENT_PORT } from "./src/config.mjs";
import { log, closeLog, logFilePath } from "./src/log.mjs";
import { AgentLock } from "./src/lock.mjs";
import { loadProfile, assertProfileUsable, profilePath } from "./src/profile.mjs";
import { captureProfile } from "./src/capture.mjs";
import { createSrSrtLiveProvider } from "./src/providers/sr-srt-live-provider.mjs";
import { JobRunner } from "./src/runner.mjs";
import { startIpcServer } from "./src/ipc-server.mjs";

const PROFILE_NAME = "sr-srt";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) args[token.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    console.error(
      [
        "playwright 를 불러오지 못했습니다.",
        "agent 폴더에서 다음을 한 번 실행해 주세요:",
        "  npm install",
        "  npx playwright install chromium",
        `원인: ${error.message}`,
      ].join("\n"),
    );
    process.exit(2);
  }
}

async function cmdCapture(args) {
  const startUrl = args.url;
  if (!startUrl) {
    console.error('사용법: railflow-agent capture --url "https://<공식 예매 화면 주소>"');
    process.exit(2);
  }
  const playwright = await loadPlaywright();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let ready = false;

  console.log(
    [
      "",
      "== 사이트 프로필 만들기 ==",
      "1) 잠시 뒤 브라우저가 열립니다. 직접 로그인해 주세요.",
      "2) 조회 화면에서 동탄 -> 울산(통도사) 를 검색해 결과를 띄우세요.",
      "3) 이 창에서 Enter 를 누르면 지금 화면의 구조를 기록합니다.",
      "4) 예약내역 화면으로 이동한 뒤에도 한 번 더 Enter 를 눌러 주세요.",
      "5) 다 되었으면 Ctrl+C 로 끝내면 됩니다.",
      "",
      "기록하는 것: 화면 라벨, 버튼 이름, 짧은 상태 문구, 방문한 주소",
      "기록하지 않는 것: 비밀번호, 쿠키, 세션, 이름/전화번호, 예약번호 원문, HTML 원문",
      "",
    ].join("\n"),
  );

  rl.on("line", () => {
    ready = true;
    setTimeout(() => {
      ready = false;
    }, 1500);
  });

  try {
    const { file } = await captureProfile({
      startUrl,
      playwright,
      isReadyForCapture: () => ready,
    });
    console.log(`\n프로필 초안을 저장했습니다: ${file}`);
    console.log("이 파일을 열어 observed 목록을 보고 vocabulary / formFields / urls 를 채운 뒤,");
    console.log('마지막에 "verified": true 로 바꿔 주세요. 그 전에는 감시가 시작되지 않습니다.');
  } finally {
    rl.close();
  }
}

function cmdCheck() {
  const file = profilePath(PROFILE_NAME);
  try {
    const profile = loadProfile(PROFILE_NAME);
    assertProfileUsable(profile);
    console.log(`프로필 확인 완료: ${file}`);
    console.log(`  대상 사업자: ${profile.operator || "(비어 있음)"}`);
    console.log(`  대상 호스트: ${profile.host}`);
    console.log(`  기록 시각:   ${profile.capturedAt}`);
    return 0;
  } catch (error) {
    console.error(`프로필을 사용할 수 없습니다(${error.code ?? "ERROR"}): ${error.message}`);
    console.error(`  파일: ${file}`);
    return 1;
  }
}

async function cmdWatch(args) {
  const config = resolveConfig({ port: args.port, livePollingIntervalSeconds: args.interval });
  for (const warning of config.warnings) console.warn(`경고: ${warning}`);

  const profile = loadProfile(PROFILE_NAME);
  assertProfileUsable(profile);

  const playwright = await loadPlaywright();
  const lock = new AgentLock();
  lock.acquire();
  lock.startHeartbeat(30_000, (error) => log.error("잠금을 잃었습니다.", { error }));

  const provider = createSrSrtLiveProvider({ profile, playwright, lock });
  const runner = new JobRunner({ config, lock, provider });
  const ipc = await startIpcServer({ port: config.port, runner });

  console.log(
    [
      "",
      "== RailFlow 로컬 Agent 실행 중 ==",
      `  주소        : http://127.0.0.1:${ipc.port}`,
      `  연결 코드   : ${ipc.pairingToken}   <- RailFlow 화면에 입력하세요`,
      `  대상        : ${provider.operator} (${profile.host})`,
      `  조회 주기   : ${config.livePollingIntervalSeconds}초 (고정)`,
      `  모드        : 읽기 전용으로 시작합니다. 예약은 화면에서 따로 승인해야 합니다.`,
      `  로그 파일   : ${logFilePath()}`,
      "",
      "  이 창을 닫거나 PC가 절전에 들어가면 감시가 멈춥니다.",
      "  중단하려면 RailFlow 화면의 [중단] 을 누르거나 이 창에서 Ctrl+C 를 누르세요.",
      "",
    ].join("\n"),
  );

  const shutdown = async () => {
    console.log("\n종료합니다...");
    runner.requestStop();
    await runner.waitUntilIdle().catch(() => {});
    await ipc.close();
    lock.release();
    await closeLog();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case "capture":
      await cmdCapture(args);
      break;
    case "check":
      process.exit(cmdCheck());
      break;
    case "watch":
      await cmdWatch(args);
      break;
    default:
      console.log(
        [
          "RailFlow Local Automation Agent",
          "",
          "  railflow-agent capture --url <공식 예매 화면 주소>   프로필 만들기",
          "  railflow-agent check                                  프로필 점검",
          `  railflow-agent watch [--port ${DEFAULT_AGENT_PORT}] [--interval 60]   감시 대기`,
          "",
          "자세한 사용법: agent/README-WINDOWS.md",
        ].join("\n"),
      );
      process.exit(command ? 2 : 0);
  }
}

main().catch(async (error) => {
  log.error("Agent 실행 실패", { error });
  console.error(`실행에 실패했습니다: ${error.message}`);
  await closeLog();
  process.exit(1);
});
