#!/usr/bin/env node
// RailFlow Local Automation Agent -- 실행 진입점.
//
// 기본 동작(`start`)은 하나다: 로컬 RailFlow 화면과 Agent를 함께 띄우고
// 브라우저로 그 화면을 연다. 사용자는 명령어를 외울 필요가 없다.
//
//   railflow-agent            로컬 화면 + Agent 시작 (기본)
//   railflow-agent start      같음
//   railflow-agent doctor     실행 조건 점검 (브라우저를 열지 않는다)
//
// 이 단계에서는 읽기 전용만 가능하다. 예약 경로는 Provider 수준에서
// 막혀 있다(allowReservation=false).

import process from "node:process";
import { spawn } from "node:child_process";
import { resolveConfig, DEFAULT_AGENT_PORT, MIN_LIVE_POLLING_INTERVAL_SECONDS } from "./src/config.mjs";
import { log, closeLog, logFilePath } from "./src/log.mjs";
import { AgentLock } from "./src/lock.mjs";
import { listProfiles } from "./src/profile.mjs";
import { Controller } from "./src/controller.mjs";
import { startIpcServer } from "./src/ipc-server.mjs";

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
        "",
        "브라우저 자동화 도구(playwright)를 불러오지 못했습니다.",
        '"1-설치.cmd" 를 한 번 실행해 주세요.',
        "",
        `자세한 원인: ${error.message}`,
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
}

/**
 * 기본 브라우저로 로컬 화면을 연다.
 *
 * 브라우저를 못 열어도 Agent는 계속 돌아야 한다. spawn 의 실패는 예외가
 * 아니라 비동기 'error' 이벤트로 오기 때문에 try/catch 로는 잡히지 않고,
 * 처리하지 않으면 프로세스 전체가 죽는다. 그래서 반드시 error 를 받는다.
 */
function openInBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      log.warn("브라우저를 자동으로 열지 못했습니다. 주소를 직접 입력해 주세요.", { error });
      console.log(`  (브라우저를 자동으로 열지 못했습니다. 주소를 직접 입력해 주세요: ${url})`);
    });
    child.unref();
  } catch (error) {
    log.warn("브라우저 실행에 실패했습니다.", { error });
  }
}

function cmdDoctor() {
  const problems = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) problems.push(`Node.js 버전이 낮습니다(${process.version}). 20 이상이 필요합니다.`);

  let playwrightOk = true;
  try {
    // 모듈 해석만 확인한다. 브라우저를 띄우지 않는다.
    import.meta.resolve("playwright");
  } catch {
    playwrightOk = false;
    problems.push('playwright 가 설치되지 않았습니다. "1-설치.cmd" 를 실행해 주세요.');
  }

  const profiles = listProfiles();
  console.log("");
  console.log("== RailFlow Agent 점검 ==");
  console.log(`  Node.js        : ${process.version}`);
  console.log(`  playwright     : ${playwrightOk ? "확인됨" : "없음"}`);
  console.log(`  저장된 프로필  : ${profiles.length}개`);
  for (const profile of profiles) {
    console.log(`    - ${profile.host} : ${profile.usable ? "사용 가능" : `사용 불가 (${profile.problem})`}`);
  }
  console.log(`  로그 파일      : ${logFilePath()}`);
  console.log("");
  if (problems.length > 0) {
    console.log("해결해야 할 것:");
    for (const problem of problems) console.log(`  * ${problem}`);
    console.log("");
    return 1;
  }
  console.log('문제 없습니다. "2-RailFlow실행.cmd" 를 실행하세요.');
  console.log("");
  return 0;
}

async function cmdStart(args) {
  const config = resolveConfig({ port: args.port, livePollingIntervalSeconds: args.interval });
  for (const warning of config.warnings) console.warn(`안내: ${warning}`);

  const playwright = await loadPlaywright();
  const lock = new AgentLock();
  try {
    lock.acquire();
  } catch (error) {
    console.error("");
    console.error(error.message);
    console.error('이미 열려 있는 RailFlow Agent 창을 닫은 뒤 다시 실행해 주세요.');
    console.error("");
    process.exit(3);
  }
  lock.startHeartbeat(30_000, (error) => log.error("잠금을 잃었습니다.", { error }));

  const controller = new Controller({ playwright, lock, config });
  const ipc = await startIpcServer({ port: config.port, controller });

  const profiles = listProfiles();
  console.log(
    [
      "",
      "== RailFlow 실제 연동 (로컬) 실행 중 ==",
      "",
      `  이 창은 닫지 마세요. 닫으면 조회가 멈춥니다.`,
      "",
      `  화면 주소   : ${ipc.consoleUrl}`,
      `  조회 주기   : ${config.livePollingIntervalSeconds}초 고정 (하한 ${MIN_LIVE_POLLING_INTERVAL_SECONDS}초)`,
      `  모드        : 읽기 전용 -- 예약 버튼은 누르지 않습니다.`,
      `  프로필      : ${profiles.length === 0 ? "없음 (화면에서 '공식 화면 열기' 부터 진행)" : profiles.map((p) => `${p.host}${p.usable ? "" : " (사용 불가)"}`).join(", ")}`,
      `  로그 파일   : ${logFilePath()}`,
      "",
      "  잠시 뒤 브라우저가 자동으로 열립니다. 열리지 않으면 위 주소를 직접 입력하세요.",
      "  종료하려면 이 창에서 Ctrl+C 를 누르거나 'RailFlow종료.cmd' 를 실행하세요.",
      "",
    ].join("\n"),
  );

  openInBrowser(ipc.consoleUrl);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n종료하는 중입니다...");
    await controller.shutdown().catch(() => {});
    await ipc.close().catch(() => {});
    lock.release();
    await closeLog();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const [, , maybeCommand, ...rest] = process.argv;
  const command = maybeCommand && !maybeCommand.startsWith("--") ? maybeCommand : "start";
  const args = parseArgs(maybeCommand && maybeCommand.startsWith("--") ? [maybeCommand, ...rest] : rest);

  switch (command) {
    case "doctor":
      process.exit(cmdDoctor());
      break;
    case "start":
      await cmdStart(args);
      break;
    default:
      console.log(
        [
          "RailFlow Local Automation Agent",
          "",
          `  railflow-agent            로컬 화면 + Agent 시작 (기본, 포트 ${DEFAULT_AGENT_PORT})`,
          "  railflow-agent doctor     실행 조건 점검",
          "",
          "보통은 직접 실행하지 않고 agent/scripts 의 .cmd 파일을 씁니다.",
          "자세한 사용법: agent/README-WINDOWS.md",
        ].join("\n"),
      );
      process.exit(2);
  }
}

main().catch(async (error) => {
  log.error("Agent 실행 실패", { error });
  console.error("");
  console.error(`실행에 실패했습니다: ${error.message}`);
  console.error(`로그: ${logFilePath()}`);
  console.error("");
  await closeLog();
  process.exit(1);
});
