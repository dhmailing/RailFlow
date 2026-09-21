import "server-only";

import type { NextRequest } from "next/server";

export class OriginError extends Error {
  readonly code = "FORBIDDEN_ORIGIN";
  constructor(message = "요청 출처를 확인할 수 없습니다.") {
    super(message);
    this.name = "OriginError";
  }
}

// A CSRF defense for cookie-authenticated mutating requests: browsers always
// attach `Origin` to same-site fetch()/form POSTs that carry credentials, so
// comparing it against a known-good value catches a cross-site page trying
// to ride the user's session cookie.
//
// (검토 재반영, §3) 이전 구현은 Origin의 host만 요청 자체의 `Host` 헤더와
// 비교했다. 두 가지 문제가 있었다:
//   1. `Host` 헤더는 프록시/로드밸런서 설정에 따라 조작되거나 신뢰할 수 없는
//      경우가 있다 -- 공격자가 통제하는 `Host` 헤더와 그 값과 일치하는
//      `Origin`을 함께 보내면 검증을 우회할 수 있었다.
//   2. host만 비교하면 스킴(scheme)을 무시한다 -- "http://example.com"과
//      "https://example.com"을 같은 출처로 오인할 수 있었다.
// 이제는 배포 시점에 운영자가 알고 있는 정확한 값을 `APP_ORIGIN` 환경변수로
// 명시하고, 요청의 `Origin`을 그 값과 (scheme + host + port까지) 비교한다.
// `Host` 헤더는 더 이상 신뢰 기준으로 쓰지 않는다.
//
// Policy (deliberately explicit, not left implicit):
//   - Only enforced when NODE_ENV==="production". Local dev/test traffic
//     (curl, this repo's own offline verify scripts, `pnpm dev` on a
//     non-HTTPS origin) is exempt so it never needs to fake an Origin header
//     or set APP_ORIGIN.
//   - Production 실제 인증을 켜려면 `APP_ORIGIN`이 유효한 절대 origin
//     (`scheme://host[:port]`, 경로 없음)으로 반드시 설정돼 있어야 한다.
//     없거나 형식이 잘못됐으면 모든 상태 변경 요청을 거부한다(fail-closed) --
//     "Host 헤더로 대신 비교"하는 폴백은 없다.
//   - Vercel Preview 배포는 매 배포마다 URL이 바뀌므로 Production과 같은
//     `APP_ORIGIN` 값을 쓸 수 없다. 이 검증은 Production 배포 환경에만
//     적용되는 것을 전제로 하며, Preview에서 실제 인증(AUTH_STORE=memory 등)을
//     켜고 싶다면 그 환경 전용의 안정적인 `APP_ORIGIN`(예: 고정 도메인을
//     연결하거나, Preview별로 실제 배포 URL을 각각 등록)을 별도로 설정해야
//     한다 -- 이번 PR은 그 배포 자동화 자체는 만들지 않았다.
//   - A MISSING Origin header on a production mutating request is REJECTED,
//     not allowed through.
//   - The request's Origin must equal APP_ORIGIN exactly (scheme AND host
//     AND port) -- "http://example.com" and "https://example.com" are
//     different origins and are never treated as equivalent.
//   - There is no allowlist of "other trusted origins" -- this app does not
//     expect cross-origin credentialed requests from anywhere.
function getConfiguredAppOrigin(): URL | null {
  const raw = (process.env.APP_ORIGIN ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // APP_ORIGIN must be a bare origin -- a path/query/hash means the operator
  // misconfigured this value (e.g. pasted the homepage URL instead of the
  // origin), and silently stripping it would hide that mistake.
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return null;
  }
  return url;
}

export function assertTrustedOrigin(request: NextRequest): void {
  if (process.env.NODE_ENV !== "production") return;

  const appOrigin = getConfiguredAppOrigin();
  if (!appOrigin) {
    throw new OriginError("APP_ORIGIN이 올바르게 설정되지 않아 요청을 거부합니다.");
  }

  const origin = request.headers.get("origin");
  if (!origin) throw new OriginError("요청 출처(Origin)를 확인할 수 없어 거부합니다.");

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new OriginError("요청 출처(Origin) 형식이 올바르지 않습니다.");
  }

  // protocol 비교로 스킴을, host 비교로 호스트명+포트를 모두 확인한다 --
  // "http://정상호스트"와 "https://정상호스트"를 같은 출처로 취급하지 않는다.
  const matches = originUrl.protocol === appOrigin.protocol && originUrl.host === appOrigin.host;
  if (!matches) {
    throw new OriginError("허용되지 않은 출처의 요청입니다.");
  }
}
