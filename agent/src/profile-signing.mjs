// 프로필 서명.
//
// 왜 필요한가
// -----------
// v0.8 초판에서는 사용자가 프로필 JSON을 열어 `"verified": true` 로 직접
// 바꿔야 했다. 그건 두 가지가 잘못됐다.
//
//   1. 사용자에게 JSON 편집을 시킨다.
//   2. `verified` 가 "Agent가 검증했다"가 아니라 "누군가 true 라고 적었다"를
//      뜻하게 된다. 검증되지 않은 프로필로도 실제 사이트를 누비게 된다.
//
// 그래서 `verified` 를 없애고 서명으로 바꿨다. 서명은 Agent의 검증 절차가
// 끝났을 때만 만들어지고, 프로필 내용이 한 글자라도 바뀌면 깨진다.
// 손으로 켤 수 있는 스위치가 아예 존재하지 않는다.
//
// 키는 이 PC에만 있다(`~/.railflow-agent/machine.key`, 0600). 저장소에도,
// 로그에도, 프로필 파일에도 들어가지 않는다.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentHomeDir } from "./config.mjs";

/** 검증 절차의 버전. 검증 규칙이 바뀌면 올린다. 옛 서명은 자동으로 무효가 된다. */
export const VERIFIER_VERSION = 2;

function machineKeyPath() {
  return path.join(agentHomeDir(), "machine.key");
}

/** 이 PC 전용 서명 키. 없으면 만든다. 사용자에게 보여줄 일이 없다. */
export function loadOrCreateMachineKey() {
  const file = machineKeyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, "utf8").trim();
    if (key.length >= 32) return key;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 에서는 chmod 가 의미 없다. 파일 위치(사용자 홈)로 보호한다.
  }
  return key;
}

/**
 * 서명 대상을 만든다. 키 순서에 상관없이 같은 내용이면 같은 문자열이 되도록
 * 정렬한다. `verification.signature` 자신은 제외한다.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function payloadOf(profile) {
  const { verification, ...rest } = profile;
  const { signature, ...verificationRest } = verification ?? {};
  void signature;
  return { ...rest, verification: verificationRest };
}

export function signProfile(profile, key = loadOrCreateMachineKey()) {
  return crypto.createHmac("sha256", key).update(canonicalize(payloadOf(profile))).digest("hex");
}

/**
 * 서명이 유효한지. 프로필을 손으로 고쳤거나, 다른 PC에서 가져왔거나,
 * 검증 규칙이 바뀌었으면 false 다.
 */
export function verifySignature(profile, key = loadOrCreateMachineKey()) {
  const signature = profile?.verification?.signature;
  if (typeof signature !== "string" || signature.length !== 64) return false;
  const expected = signProfile(profile, key);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 화면 구조 지문(fingerprint).
 *
 * 캡처 당시의 구조와 지금 화면의 구조가 같은지 확인하는 데 쓴다. 사이트가
 * 개편되면 값이 달라지고, 그러면 옛 프로필로 잘못된 요소를 읽는 대신
 * 멈춘다. 개인정보가 섞이지 않도록 "구조"만 넣는다 -- 역할·태그의 종류와
 * 개수, 폼 라벨 목록, 행의 칸 수. 사람 이름이나 예약번호는 들어가지 않는다.
 */
export function computeFingerprint(structure) {
  const normalized = {
    formLabels: [...(structure.formLabels ?? [])].sort(),
    controlNames: [...(structure.controlNames ?? [])].sort(),
    rowCellCount: structure.rowCellCount ?? 0,
    rowContainerTag: structure.rowContainerTag ?? "",
    landmarkCounts: structure.landmarkCounts ?? {},
  };
  return crypto.createHash("sha256").update(canonicalize(normalized)).digest("hex").slice(0, 32);
}
