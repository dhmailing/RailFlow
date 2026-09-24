// 사이트 프로필(화면 어휘) 로드·검증.
//
// 왜 이런 게 있는가
// -----------------
// 지침 §7은 "공식 화면에 직접 접근한 뒤 실제 DOM을 확인해 선택자를
// 작성한다", "임의의 selector, endpoint, 응답 필드를 추측하지 않는다"고
// 못박는다. 이 저장소를 만드는 개발 환경은 공식 예매 사이트로 나가는
// 연결이 차단되어 있어(docs/V0.8-LIVE-BOOKING-AGENT.md §2) 화면을 볼 수
// 없다. 그래서 어떤 선택자도, 어떤 화면 문구도 코드에 박아 넣지 않았다.
//
// 대신 Agent 자신이 사용자의 PC에서 `capture` 명령으로 실제 화면을 열고,
// 거기서 관찰한 것만 프로필에 적는다. 프로필이 `verified: true` 가 되기
// 전에는 LIVE_READ_ONLY 도 동작하지 않는다(PROVIDER_PROFILE_REQUIRED).
//
// 즉 이 파일은 "추측하지 않았다"를 코드로 강제하는 장치다.

import fs from "node:fs";
import path from "node:path";
import { profileDir } from "./config.mjs";

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

/** 프로필이 반드시 채워야 하는 항목. 하나라도 비면 실행을 거부한다. */
const REQUIRED_VOCABULARY = Object.freeze([
  "soldOut", // 매진을 뜻하는 화면 문구들
  "availableStandard", // 일반실 예약 가능을 뜻하는 문구/표시
  "availableFirst", // 특실 예약 가능을 뜻하는 문구/표시
  "reserveControl", // 예약(예매) 버튼의 접근성 이름
  "reservationListLink", // 예약내역으로 가는 링크의 접근성 이름
]);

/**
 * 프로필 뼈대. `capture` 가 관찰한 값으로 채운다.
 * 여기에 예시 문구를 넣지 않는 것이 핵심이다 -- 예시를 넣으면 그게 곧
 * 추측한 선택자가 된다.
 */
export function emptyProfile({ operator = "", host = "" } = {}) {
  return {
    schemaVersion: 1,
    operator, // 예: 화면에서 확인한 사업자명
    host, // 예: 실제로 접속한 호스트
    capturedAt: null,
    capturedFromUrl: null,
    verified: false,
    // capture 중에 실제로 방문한 주소만 기록한다. 추측해서 적지 않는다.
    urls: {
      searchEntry: "", // 열차 조회 화면
      reservationList: "", // 예약내역 화면
    },
    // 화면에서 관찰한 문구만 들어간다. 각 값은 문자열 배열.
    vocabulary: {
      soldOut: [],
      availableStandard: [],
      availableFirst: [],
      waitlist: [],
      additionalVerification: [],
      queueOrRestricted: [],
      loginRequired: [],
      reserveControl: [],
      reservationListLink: [],
      reservationSuccess: [],
      paymentDeadlineLabel: [],
      reservationNumberLabel: [],
    },
    // 조회 폼 항목의 접근성 이름(label). capture 중 관찰한 것만 적는다.
    formFields: {
      departure: "",
      arrival: "",
      date: "",
      passengers: "",
      submit: "",
    },
    // 결제 화면으로 넘어갔음을 뜻하는 표시. 여기 걸리면 즉시 중단한다.
    paymentScreenMarkers: [],
    notes: "",
  };
}

export function profilePath(name) {
  return path.join(profileDir(), `${name}.profile.json`);
}

export function saveProfile(name, profile) {
  const file = profilePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return file;
}

export function loadProfile(name) {
  const file = profilePath(name);
  if (!fs.existsSync(file)) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      `사이트 프로필이 없습니다(${file}). 먼저 "railflow-agent capture" 를 한 번 실행해 실제 화면에서 프로필을 만들어 주세요.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ProfileError("PROVIDER_PROFILE_REQUIRED", `사이트 프로필을 읽을 수 없습니다: ${error.message}`);
  }
  return parsed;
}

/**
 * 프로필이 실제로 쓸 수 있는 상태인지 확인한다.
 * 통과하지 못하면 Agent는 조회도 클릭도 하지 않는다.
 */
export function assertProfileUsable(profile) {
  if (!profile || typeof profile !== "object") {
    throw new ProfileError("PROVIDER_PROFILE_REQUIRED", "사이트 프로필이 비어 있습니다.");
  }
  if (profile.schemaVersion !== 1) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      `지원하지 않는 프로필 형식입니다(schemaVersion=${profile.schemaVersion}). 다시 capture 해 주세요.`,
    );
  }
  if (!profile.verified) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      "사이트 프로필이 아직 확인되지 않았습니다. capture 결과를 검토한 뒤 verified 를 true 로 바꿔 주세요.",
    );
  }
  if (!profile.host) {
    throw new ProfileError("PROVIDER_PROFILE_REQUIRED", "프로필에 대상 호스트가 없습니다.");
  }
  const missing = REQUIRED_VOCABULARY.filter((key) => {
    const value = profile.vocabulary?.[key];
    return !Array.isArray(value) || value.length === 0;
  });
  if (missing.length > 0) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      `프로필에서 다음 항목이 비어 있습니다: ${missing.join(", ")}. 실제 화면에서 확인한 문구로 채워 주세요.`,
    );
  }
  const missingFields = ["departure", "arrival", "date", "submit"].filter(
    (key) => !profile.formFields?.[key],
  );
  if (missingFields.length > 0) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      `프로필의 조회 폼 항목이 비어 있습니다: ${missingFields.join(", ")}. 실제 화면의 라벨 문구여야 합니다.`,
    );
  }
  const missingUrls = ["searchEntry", "reservationList"].filter((key) => !profile.urls?.[key]);
  if (missingUrls.length > 0) {
    throw new ProfileError(
      "PROVIDER_PROFILE_REQUIRED",
      `프로필에서 다음 주소가 비어 있습니다: ${missingUrls.join(", ")}. capture 중 실제로 방문한 주소여야 합니다.`,
    );
  }
  // 프로필에 적힌 주소가 프로필의 호스트와 같은지 확인한다. 다르면
  // 잘못된 프로필이거나 손을 탄 것이므로 실행하지 않는다.
  for (const key of ["searchEntry", "reservationList"]) {
    let parsed;
    try {
      parsed = new URL(profile.urls[key]);
    } catch {
      throw new ProfileError("PROVIDER_PROFILE_REQUIRED", `프로필의 ${key} 주소 형식이 잘못됐습니다.`);
    }
    if (parsed.hostname !== profile.host) {
      throw new ProfileError(
        "PROVIDER_PROFILE_REQUIRED",
        `프로필의 ${key} 호스트(${parsed.hostname})가 대상 호스트(${profile.host})와 다릅니다.`,
      );
    }
  }
  return true;
}

/**
 * 화면에서 읽은 문구가 프로필의 어떤 어휘에 해당하는지 찾는다.
 * 부분 일치를 쓰되, 프로필에 적힌 문구가 화면 문구 안에 통째로 들어있을
 * 때만 인정한다. 반대 방향(화면 문구가 프로필 문구의 일부)은 인정하지
 * 않는다 -- "매진"이 "매진임박"에 걸리는 것 같은 오판을 막기 위해서다.
 */
export function classifyScreenText(profile, screenText) {
  const text = String(screenText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  for (const [key, phrases] of Object.entries(profile.vocabulary ?? {})) {
    if (!Array.isArray(phrases)) continue;
    for (const phrase of phrases) {
      const needle = String(phrase).replace(/\s+/g, " ").trim();
      if (needle && text.includes(needle)) return { key, phrase: needle };
    }
  }
  return null;
}
