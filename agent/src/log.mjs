// 로그. 모든 출력은 redact.mjs 를 거친다.
//
// 절대 기록하지 않는 것: DOM 전체, 쿠키, 세션 토큰, 비밀번호, OTP, 카드정보.
// 화면에서 읽은 문구는 safeScreenText() 로 길이를 제한해 보존한다.

import fs from "node:fs";
import path from "node:path";
import { logDir } from "./config.mjs";
import { redactValue } from "./redact.mjs";

let stream = null;
let currentPath = null;

function ensureStream() {
  if (stream) return stream;
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  currentPath = path.join(dir, `agent-${day}.log`);
  stream = fs.createWriteStream(currentPath, { flags: "a" });
  return stream;
}

export function logFilePath() {
  ensureStream();
  return currentPath;
}

function write(level, message, fields) {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: typeof message === "string" ? message : String(message),
    ...(fields ? { data: redactValue(fields) } : {}),
  };
  const line = JSON.stringify(redactValue(record));
  ensureStream().write(`${line}\n`);
  // 테스트에서는 콘솔 출력을 끈다. 파일 로그는 그대로 남는다.
  if (process.env.RAILFLOW_AGENT_QUIET === "1") return;
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

export async function closeLog() {
  if (!stream) return;
  await new Promise((resolve) => stream.end(resolve));
  stream = null;
}
