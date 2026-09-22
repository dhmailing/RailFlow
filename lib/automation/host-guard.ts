import "server-only";

import { AutomationError } from "@/lib/automation/types";

// (§3-E 호스트 안전장치) The automation Worker's Playwright browser may only
// ever be pointed at RailFlow's OWN Mock booking site. This is an allowlist,
// not a denylist: anything that is not explicitly loopback or this exact
// deployment's own Vercel hostname is rejected, so a new external domain
// never needs a matching new "block" rule to stay blocked. The explicit
// denylist below is defense-in-depth on top of that allowlist, not the
// primary defense.
const EXPLICITLY_BLOCKED_HOST_SUFFIXES = [
  "korail.com",
  "letskorail.com",
  "srail.or.kr",
  "srail.co.kr",
  "sr.co.kr",
  "data.go.kr",
  "kric.go.kr",
];

function isBlockedByDenylist(hostname: string): boolean {
  return EXPLICITLY_BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// The current deployment's own hostname, as assigned by the Vercel platform
// itself (never user- or config-supplied) -- this is what makes "승인된
// Vercel Preview" allowed without opening the door to an arbitrary domain:
// only *this* running deployment's exact address ever matches.
function currentDeploymentHostname(): string | null {
  const value = (process.env.VERCEL_URL ?? "").trim().toLowerCase();
  return value || null;
}

function denyNotAllowed(hostname: string): never {
  throw new AutomationError("AUTOMATION_TARGET_NOT_ALLOWED", `허용되지 않은 자동화 대상 호스트입니다: ${hostname}`);
}

// Non-throwing core, shared by the assert* wrappers below and by
// mock-browser-provider.ts's request-level interceptor (which needs a
// boolean per request, not an exception per call -- see isAutomationTargetAllowed).
function evaluateAutomationTarget(rawUrl: string): { allowed: true; hostname: string } | { allowed: false; hostname: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, hostname: rawUrl };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, hostname: url.hostname || rawUrl };
  }

  const hostname = url.hostname.toLowerCase();

  if (isBlockedByDenylist(hostname)) {
    return { allowed: false, hostname };
  }

  if (isLoopbackHostname(hostname)) {
    return { allowed: true, hostname };
  }

  const selfHost = currentDeploymentHostname();
  if (url.protocol === "https:" && selfHost && hostname === selfHost) {
    return { allowed: true, hostname };
  }

  // Everything else -- a literal IP address (public or private), a
  // "사설 프록시" address, a user-typed URL, or any domain that is not this
  // exact deployment -- is rejected here. There is deliberately no IP-
  // literal special case: an IP never equals "localhost"/"127.0.0.1"/
  // selfHost by string comparison, so it always falls through to this
  // rejection regardless of notation (dotted-decimal, hex, octal, or
  // decimal -- the WHATWG URL parser normalizes all of those to canonical
  // dotted-decimal before this function ever sees `hostname`, so a
  // disguised loopback address is normalized to the exact string
  // "127.0.0.1" and still only matches the intended loopback case).
  return { allowed: false, hostname };
}

// Non-throwing predicate for request-level interception (mock-browser-
// provider.ts's page.route() handler) -- every single outgoing request
// (initial navigation, redirects, subresources) is checked against this
// *before* it leaves the browser, not only the final page.url() after the
// fact. Checking only the post-navigation URL would miss a request that was
// already sent to a disallowed host as part of a redirect chain -- a
// same-origin page a real automation target might one day serve could still
// redirect off-host, and by the time goto() resolves that request has
// already gone out. This function is what lets the interceptor abort such a
// request before it is ever sent.
export function isAutomationTargetAllowed(rawUrl: string): boolean {
  return evaluateAutomationTarget(rawUrl).allowed;
}

// Validates one candidate automation target. Called (a) before Playwright's
// very first navigation, using a URL this module itself constructs (never a
// user-supplied one -- see mock-browser-provider.ts, which takes no `url`
// parameter from any caller), and (b) again against `page.url()` after that
// navigation settles, so a redirect to a disallowed host is caught even
// though goto() already followed it (§4: "리디렉션 후 호스트 재검증"). Both
// of these are on top of, not instead of, the request-level interceptor
// above -- that one blocks the request before it is sent; these two catch
// the case where somehow it already was (defense-in-depth, not the sole
// guard). Throws AUTOMATION_TARGET_NOT_ALLOWED when the target is not
// allowed.
export function assertAutomationTargetAllowed(rawUrl: string): URL {
  const result = evaluateAutomationTarget(rawUrl);
  if (!result.allowed) {
    denyNotAllowed(result.hostname);
  }
  return new URL(rawUrl);
}

// Re-validates the browser's *actual* current address after a navigation
// has completed (following any redirect chain) -- see the call site in
// mock-browser-provider.ts. This is a plain re-use of
// assertAutomationTargetAllowed against the live post-navigation URL; no
// separate DNS lookup is performed because the only hosts this module can
// ever allow (loopback, or this exact deployment's own Vercel-assigned
// hostname) have no meaningful "wrong DNS answer" scenario to defend
// against -- see docs/V0.7-AUTOMATION-BOUNDARY.md for why DNS rebinding
// defense does not add anything here.
export function assertPostNavigationTargetAllowed(currentUrl: string): URL {
  return assertAutomationTargetAllowed(currentUrl);
}

// The one place a target URL for the mock-browser Provider is ever built.
// Never accepts a caller-supplied URL/host/port -- only a path + query the
// module itself controls.
export function buildAutomationTargetUrl(pathAndQuery: string): string {
  const selfHost = currentDeploymentHostname();
  const base = selfHost ? `https://${selfHost}` : (process.env.AUTOMATION_TARGET_BASE_URL || "http://localhost:3000");
  const url = new URL(pathAndQuery, base);
  assertAutomationTargetAllowed(url.toString());
  return url.toString();
}
