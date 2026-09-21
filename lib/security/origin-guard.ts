import "server-only";

import type { NextRequest } from "next/server";

export class OriginError extends Error {
  readonly code = "FORBIDDEN_ORIGIN";
  constructor(message = "요청 출처를 확인할 수 없습니다.") {
    super(message);
    this.name = "OriginError";
  }
}

// A lightweight CSRF defense for cookie-authenticated mutating requests:
// browsers always attach `Origin` to same-site fetch()/form POSTs that carry
// credentials, so comparing it against the request's own `Host` catches a
// cross-site page trying to ride the user's session cookie.
//
// Policy (deliberately explicit, not left implicit):
//   - Only enforced when NODE_ENV==="production". Local dev/test traffic
//     (curl, this repo's own offline verify scripts, `pnpm dev` on a
//     non-HTTPS origin) is exempt so it never needs to fake an Origin header.
//   - A MISSING Origin header on a production mutating request is REJECTED,
//     not allowed through. Real browsers send Origin on every credentialed
//     cross-origin-capable request (fetch/XHR/form POST) that this app's own
//     client code issues; a request arriving without one is either a very
//     old browser edge case (not a target for this account/watch-job
//     feature) or a non-browser client forging the request, and treating
//     "missing" as "trusted" would defeat the whole check.
//   - Origin host must equal the request's own Host header exactly. There is
//     no allowlist of "other trusted origins" -- this app does not expect
//     cross-origin credentialed requests from anywhere.
export function assertTrustedOrigin(request: NextRequest): void {
  if (process.env.NODE_ENV !== "production") return;

  const origin = request.headers.get("origin");
  if (!origin) throw new OriginError("요청 출처(Origin)를 확인할 수 없어 거부합니다.");

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new OriginError("요청 출처(Origin) 형식이 올바르지 않습니다.");
  }

  const host = request.headers.get("host");
  if (!host || originHost !== host) {
    throw new OriginError("허용되지 않은 출처의 요청입니다.");
  }
}
