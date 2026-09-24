// 개인정보·인증정보 마스킹.
//
// Agent가 남기는 모든 로그·상태·화면 캡처는 이 모듈을 반드시 거친다.
// 여기서 막는 것(지침 §6, §14):
//   - 아이디/비밀번호/OTP/보안문자
//   - 쿠키 원문, 세션 토큰, Authorization 헤더
//   - 카드번호
//   - 이름/전화번호/이메일/생년월일
//   - 예약번호(마스킹해서 뒤 3자리만 남긴다 -- 사용자가 화면에서 대조할 수
//     있어야 하지만 로그 파일에 원문이 남으면 안 되기 때문)
//
// 이 모듈은 "줄이는" 쪽으로만 동작한다. 확실하지 않으면 지운다.

const PATTERNS = [
  // 카드번호(구분자 유무 모두). 가장 먼저 지운다.
  [/\b(?:\d[ -]?){13,19}\b/g, "[CARD_OR_LONG_NUMBER]"],
  // 이메일
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
  // 국내 휴대전화/일반전화
  [/\b0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}\b/g, "[PHONE]"],
  // 주민등록번호 형태
  [/\b\d{6}[- ]?\d{7}\b/g, "[NATIONAL_ID]"],
  // 생년월일 형태(YYYYMMDD / YYYY-MM-DD 는 날짜로도 쓰이므로 8자리 연속만)
  [/\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/g, "[DATE8]"],
  // 쿠키/토큰/인증 헤더 형태의 key=value
  [
    /\b(cookie|set-cookie|authorization|session[-_]?id|jsessionid|access[-_]?token|refresh[-_]?token|bearer|csrf[-_]?token|otp|passwd|password|pwd)\b\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  ],
  // 긴 무작위 문자열(토큰으로 보이는 것).
  // 단, 상태 이름처럼 대문자와 밑줄로만 된 값은 건드리지 않는다 --
  // RESULT_UNCERTAIN_USER_CHECK_REQUIRED(36자) 같은 상태가 통째로
  // [LONG_TOKEN] 이 되어 화면과 로그에서 상태를 못 읽는 일이 있었다.
  [
    /\b[A-Za-z0-9_-]{32,}\b/g,
    (match) => (/^[A-Z0-9_]+$/.test(match) ? match : "[LONG_TOKEN]"),
  ],
];

/** 예약번호는 뒤 3자리만 남긴다. 사용자는 화면과 대조할 수 있고, 로그에는 원문이 없다. */
export function maskReservationNumber(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length <= 3) return "*".repeat(trimmed.length);
  return `${"*".repeat(trimmed.length - 3)}${trimmed.slice(-3)}`;
}

/** 사람 이름으로 보이는 값을 첫 글자만 남기고 가린다. */
export function maskPersonName(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return `${value[0]}${"*".repeat(Math.max(value.length - 1, 1))}`;
}

/** 자유 텍스트에서 개인정보·인증정보로 보이는 부분을 지운다. */
export function redactText(input) {
  if (input == null) return input;
  let text = String(input);
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

const SENSITIVE_KEY = /(password|passwd|pwd|otp|cookie|token|secret|authorization|session|card|cvc|cvv|ssn|jumin|birth)/i;
const NAME_KEY = /(passengerName|userName|customerName|holderName|^name$)/i;
const RESERVATION_KEY = /(reservationNumber|reservationNo|pnr|ticketNumber)/i;

/** 객체 전체를 재귀적으로 마스킹한다. 로그·IPC 응답·상태 저장 직전에 호출한다. */
export function redactValue(value, depth = 0) {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: value.code };
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[REDACTED]";
      } else if (RESERVATION_KEY.test(key) && typeof item === "string") {
        out[key] = maskReservationNumber(item);
      } else if (NAME_KEY.test(key) && typeof item === "string") {
        out[key] = maskPersonName(item);
      } else {
        out[key] = redactValue(item, depth + 1);
      }
    }
    return out;
  }
  return "[UNSERIALIZABLE]";
}

/**
 * 화면에서 읽은 원본 문구를 보존할 때 쓴다(지침 §8: 상태 문구와 원본 텍스트를
 * 함께 보존하되 개인정보는 남기지 않는다). 길이도 제한해 DOM 덩어리가
 * 통째로 로그에 들어가는 일을 막는다.
 */
export function safeScreenText(raw, maxLength = 120) {
  if (raw == null) return "";
  const collapsed = String(raw).replace(/\s+/g, " ").trim();
  const redacted = redactText(collapsed);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
