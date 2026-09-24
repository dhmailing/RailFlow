// 브라우저에서 로컬 Agent(127.0.0.1)로 보내는 요청.
//
// 이 파일은 서버에서 쓰이지 않는다. Vercel 함수는 사용자의 PC에 있는
// Agent에 접근할 수 없고, 접근하려고 시도해서도 안 된다. 실제 자동화는
// 전적으로 사용자의 PC 안에서만 일어난다.
//
// 연결 코드(페어링 토큰)는 sessionStorage 에만 둔다. 서버로 보내지 않고,
// 새로고침해도 탭을 닫으면 사라진다.

"use client";

import type { LiveAgentSnapshot, LiveArmEcho, LiveJobInput } from "@/lib/live/agent-protocol";

export const DEFAULT_AGENT_ORIGIN = "http://127.0.0.1:4319";
const TOKEN_STORAGE_KEY = "railflow.agentPairingToken";

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export class AgentPairingRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPairingRequiredError";
  }
}

export function readPairingToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writePairingToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    /* 저장할 수 없어도 이번 세션 동안은 메모리로 동작한다 */
  }
}

type RequestOptions = { origin?: string; token?: string; signal?: AbortSignal };

async function request<T>(
  path: string,
  init: RequestInit & RequestOptions = {},
): Promise<T> {
  const { origin = DEFAULT_AGENT_ORIGIN, token = readPairingToken(), signal, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      ...rest,
      signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-railflow-agent-token": token } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch {
    throw new AgentUnavailableError(
      "PC에서 실행 중인 RailFlow Agent를 찾지 못했습니다. Agent를 먼저 실행해 주세요.",
    );
  }
  if (response.status === 401) {
    throw new AgentPairingRequiredError("Agent 창에 표시된 연결 코드를 입력해 주세요.");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(body.message ?? body.error ?? `요청에 실패했습니다(${response.status}).`));
  }
  return body as T;
}

/** Agent가 떠 있는지만 확인한다. 연결 코드 없이도 호출된다. */
export async function pingAgent(origin = DEFAULT_AGENT_ORIGIN): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/ping`, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export function getStatus(options: RequestOptions = {}) {
  return request<LiveAgentSnapshot>("/status", { method: "GET", ...options });
}

export function startJob(input: LiveJobInput, options: RequestOptions = {}) {
  return request<{ id: string; status: LiveAgentSnapshot }>("/jobs", {
    method: "POST",
    body: JSON.stringify(input),
    ...options,
  });
}

export function confirmLogin(options: RequestOptions = {}) {
  return request<LiveAgentSnapshot>("/jobs/confirm-login", { method: "POST", ...options });
}

/** 실제 예약 승인. 화면이 보여준 조건을 그대로 보내 Agent가 대조하게 한다. */
export function armReservation(echo: LiveArmEcho, options: RequestOptions = {}) {
  return request<LiveAgentSnapshot>("/jobs/arm", {
    method: "POST",
    body: JSON.stringify(echo),
    ...options,
  });
}

export function stopJob(options: RequestOptions = {}) {
  return request<LiveAgentSnapshot>("/jobs/stop", { method: "POST", ...options });
}

/**
 * 상태 변화를 실시간으로 받는다. EventSource 는 헤더를 못 붙이므로
 * 연결 코드를 쿼리로 넘긴다 -- 127.0.0.1 로만 나가는 요청이고, 코드는
 * 실행할 때마다 새로 만들어지는 임시 값이다.
 */
export function subscribe(
  onSnapshot: (snapshot: LiveAgentSnapshot) => void,
  options: RequestOptions = {},
): () => void {
  const { origin = DEFAULT_AGENT_ORIGIN, token = readPairingToken() } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // EventSource 대신 폴링을 쓴다. 로컬 통신이라 부담이 없고, 연결 코드를
  // 헤더로 보낼 수 있어 쿼리스트링에 남기지 않아도 된다.
  const tick = async () => {
    if (stopped) return;
    try {
      onSnapshot(await getStatus({ origin, token }));
    } catch {
      /* Agent가 꺼졌을 수 있다. 다음 주기에 다시 시도한다. */
    }
    if (!stopped) timer = setTimeout(tick, 1500);
  };
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
