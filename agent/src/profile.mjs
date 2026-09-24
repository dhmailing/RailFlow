// 사이트 프로필 (schema v2).
//
// v1 과 달라진 점
// ---------------
//  - `verified: true` 를 사용자가 손으로 켜던 것을 없앴다. 이제 Agent의
//    검증 절차가 끝났을 때만 서명이 붙고, 내용이 바뀌면 서명이 깨진다
//    (profile-signing.mjs).
//  - 화면 문구 목록만 갖고 있던 것을, 실제로 사용자가 화면에서 지정한
//    "의미 위치"(행 안의 어느 칸이 열차번호인지, 어느 칸이 일반실 상태인지)
//    까지 갖도록 바꿨다.
//  - 대상 사업자·호스트를 파일 이름으로 먼저 정하지 않는다. 사용자가 실제로
//    연 화면의 호스트를 확인한 뒤 그 호스트로 파일 이름을 만든다.
//
// 여전히 지키는 것: 이 저장소에는 어떤 선택자도, 어떤 화면 문구도 없다.
// 전부 사용자의 PC에서 실제 화면을 열어 채운다.

import fs from "node:fs";
import path from "node:path";
import { profileDir } from "./config.mjs";
import { VERIFIER_VERSION, signProfile, verifySignature } from "./profile-signing.mjs";

export const PROFILE_SCHEMA_VERSION = 2;

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

/** 호스트에서 파일 이름을 만든다. 사업자 이름을 먼저 정하고 맞추지 않는다. */
export function profileFileName(host) {
  return `${String(host).replace(/[^a-z0-9.-]/gi, "_")}.profile.json`;
}

export function profilePath(host) {
  return path.join(profileDir(), profileFileName(host));
}

/** 저장된 프로필 목록. 로컬 화면이 "어떤 사이트를 캡처해 뒀는지" 보여줄 때 쓴다. */
export function listProfiles() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".profile.json"))
    .map((name) => {
      try {
        const profile = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        const usable = checkProfile(profile);
        return {
          file: name,
          host: profile.host,
          operator: profile.operator,
          capturedAt: profile.capturedAt,
          usable: usable.ok,
          problem: usable.ok ? null : usable.problem,
        };
      } catch {
        return { file: name, host: null, operator: null, capturedAt: null, usable: false, problem: "읽을 수 없는 파일" };
      }
    });
}

/**
 * 빈 프로필. 예시 문구를 절대 넣지 않는다 -- 예시를 넣는 순간 그게 추측한
 * 선택자가 된다.
 *
 * `fieldPaths` 는 사용자가 화면에서 직접 클릭해 지정한 위치다. 각 항목은
 * 행(row)을 기준으로 한 상대 경로 + 교차확인용 역할/태그 정보를 담는다.
 */
export function emptyProfile({ host = "", operator = "" } = {}) {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    host,
    operator,
    capturedAt: null,
    profileVersion: 1,
    // 캡처 중 실제로 방문한 주소만 기록한다.
    pages: {
      search: { url: "", kind: "" },
      reservationList: { url: "", kind: "" },
    },
    // 허용 호스트. 캡처된 공식 호스트와, 캡처 중 실제로 거친 하위 호스트만.
    allowedHosts: [],
    // 결과 표의 행 구조와, 행 안에서 각 정보가 있는 자리.
    row: {
      containerTag: "",
      containerRole: "",
      cellCount: 0,
      fieldPaths: {
        trainNumber: null,
        departAt: null,
        arriveAt: null,
        standardSeat: null,
        firstSeat: null,
      },
    },
    // 조회 폼. 접근성 이름만 저장한다.
    form: {
      departure: "",
      arrival: "",
      date: "",
      passengers: "",
      submit: "",
    },
    // 상태 판정용 문구. 사용자가 화면에서 확인한 것만.
    detectors: {
      soldOut: [],
      availableStandard: [],
      availableFirst: [],
      waitlist: [],
      standingRoom: [],
      loginRequired: [],
      additionalVerification: [],
      queueOrRestricted: [],
    },
    // 결제/예약 화면으로 넘어갔음을 뜻하는 표시. 걸리면 즉시 중단한다.
    guardMarkers: {
      paymentScreen: [],
      reservationScreen: [],
    },
    fingerprint: "",
    verification: null,
  };
}

export function saveProfile(profile) {
  if (!profile.host) throw new ProfileError("PROVIDER_PROFILE_REQUIRED", "프로필에 호스트가 없습니다.");
  const file = profilePath(profile.host);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return file;
}

export function loadProfile(host) {
  const file = profilePath(host);
  if (!fs.existsSync(file)) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      `이 사이트의 프로필이 아직 없습니다(${host}). RailFlow 화면에서 "공식 화면 연결"을 먼저 진행해 주세요.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ProfileError("PROVIDER_PROFILE_REQUIRED", `프로필을 읽을 수 없습니다: ${error.message}`);
  }
}

/**
 * 검증 절차가 끝난 프로필에 서명을 붙인다. 이 함수를 거치지 않으면
 * 어떤 프로필도 사용 가능해지지 않는다.
 *
 * @param {object} profile
 * @param {Array<{name: string, ok: boolean, detail?: string}>} checks 자동 검증 결과
 */
export function finalizeProfile(profile, checks) {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new ProfileError(
      "PROFILE_VERIFICATION_FAILED",
      `자동 검증에 실패했습니다: ${failed.map((check) => check.name).join(", ")}`,
    );
  }
  const draft = {
    ...profile,
    verification: {
      verifiedAt: new Date().toISOString(),
      verifierVersion: VERIFIER_VERSION,
      checks: checks.map((check) => ({ name: check.name, ok: check.ok })),
    },
  };
  draft.verification.signature = signProfile(draft);
  return draft;
}

/**
 * 프로필이 지금 쓸 수 있는 상태인지. 던지지 않고 결과를 돌려준다.
 * 로컬 화면이 "왜 못 쓰는지"를 그대로 보여줄 수 있어야 하기 때문이다.
 */
export function checkProfile(profile) {
  const fail = (code, problem) => ({ ok: false, code, problem });

  if (!profile || typeof profile !== "object") return fail("PROVIDER_PROFILE_REQUIRED", "프로필이 비어 있습니다.");
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    return fail(
      "PROVIDER_PROFILE_REQUIRED",
      `프로필 형식이 달라 다시 만들어야 합니다(schemaVersion=${profile.schemaVersion}).`,
    );
  }
  if (!profile.host) return fail("PROVIDER_PROFILE_REQUIRED", "대상 호스트가 없습니다.");

  // 서명 검사 -- 손으로 고친 프로필은 여기서 걸린다.
  if (!profile.verification) {
    return fail("PROVIDER_PROFILE_REQUIRED", "아직 검증되지 않은 프로필입니다.");
  }
  if (profile.verification.verifierVersion !== VERIFIER_VERSION) {
    return fail(
      "PROFILE_VERIFICATION_STALE",
      `검증 규칙이 바뀌었습니다(프로필 v${profile.verification.verifierVersion}, 현재 v${VERIFIER_VERSION}). 다시 연결해 주세요.`,
    );
  }
  if (!verifySignature(profile)) {
    return fail(
      "PROFILE_TAMPERED",
      "프로필이 검증 이후에 변경됐거나 다른 PC에서 만들어졌습니다. 손으로 고친 프로필은 사용할 수 없습니다. 다시 연결해 주세요.",
    );
  }

  // 내용 검사 -- 서명이 맞아도 비어 있으면 못 쓴다.
  const missing = [];
  for (const key of ["trainNumber", "departAt", "standardSeat"]) {
    if (!profile.row?.fieldPaths?.[key]) missing.push(`행의 ${key} 위치`);
  }
  for (const key of ["departure", "arrival", "date", "submit"]) {
    if (!profile.form?.[key]) missing.push(`조회 폼의 ${key}`);
  }
  for (const key of ["soldOut", "availableStandard"]) {
    if (!Array.isArray(profile.detectors?.[key]) || profile.detectors[key].length === 0) {
      missing.push(`상태 문구 ${key}`);
    }
  }
  if (!profile.pages?.search?.url) missing.push("조회 화면 주소");
  if (!profile.pages?.reservationList?.url) missing.push("예약내역 화면 주소");
  if (!profile.fingerprint) missing.push("화면 구조 지문");
  if (missing.length > 0) {
    return fail("PROVIDER_PROFILE_REQUIRED", `프로필에 빠진 항목이 있습니다: ${missing.join(", ")}`);
  }

  // 주소가 허용 호스트 안에 있는지.
  for (const key of ["search", "reservationList"]) {
    let parsed;
    try {
      parsed = new URL(profile.pages[key].url);
    } catch {
      return fail("PROVIDER_PROFILE_REQUIRED", `${key} 주소 형식이 잘못됐습니다.`);
    }
    if (!isHostAllowed(profile, parsed.hostname)) {
      return fail("PROVIDER_PROFILE_REQUIRED", `${key} 주소(${parsed.hostname})가 허용 호스트 밖입니다.`);
    }
  }
  return { ok: true };
}

export function assertProfileUsable(profile) {
  const result = checkProfile(profile);
  if (!result.ok) throw new ProfileError(result.code, result.problem);
  return true;
}

/** 허용 호스트인지. 캡처된 호스트와 명시적으로 저장된 하위 호스트만 통과한다. */
export function isHostAllowed(profile, hostname) {
  const allowed = new Set([profile.host, ...(profile.allowedHosts ?? [])].filter(Boolean));
  return allowed.has(hostname);
}

/**
 * 화면에서 읽은 문구를 상태로 분류한다. 프로필에 적힌 문구가 화면 문구 안에
 * 통째로 들어있을 때만 인정한다("매진"이 "매진임박"에 걸리는 오판 방지는
 * 호출부에서 문구 우선순위로 처리한다).
 */
export function classifyScreenText(profile, screenText) {
  const text = String(screenText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  // 더 긴 문구를 먼저 본다. "예약대기"가 "예약"보다 먼저 걸리게 하기 위해서다.
  const entries = [];
  for (const [key, phrases] of Object.entries(profile.detectors ?? {})) {
    if (!Array.isArray(phrases)) continue;
    for (const phrase of phrases) {
      const needle = String(phrase).replace(/\s+/g, " ").trim();
      if (needle) entries.push({ key, phrase: needle });
    }
  }
  entries.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const entry of entries) {
    if (text.includes(entry.phrase)) return entry;
  }
  return null;
}
