import "server-only";

// Provider별 요청 제한과 백오프.
//
// v0.8에서 배운 것: 고정 주기를 지켰는데도 운영자가 자동화로 판정했다.
// 그래서 이번에는 "얼마나 자주"를 우리가 정하지 않는다 -- 공개된 제한을
// 확인한 경우 그 값을 쓰고, 확인하지 못했으면 보수적인 값을 쓴다.
//
// 지수 백오프에는 **상한이 있다.** 상한 없는 재시도는 그 자체가 폭주다.

export type RateLimitPolicy = {
  /** 이 Provider 에 대한 최소 조회 간격(초). */
  minIntervalSeconds: number;
  /** 429·접근 제한을 만났을 때의 백오프 단계(초). 마지막 값을 넘으면 중단한다. */
  backoffSeconds: readonly number[];
  /** 한 작업이 연속으로 실패할 수 있는 최대 횟수. */
  maxConsecutiveFailures: number;
  /** 이 정책의 근거. "확인됨"이 아니면 보수적인 기본값이라는 뜻이다. */
  basis: "official_documented" | "conservative_default";
};

const POLICIES: Readonly<Record<string, RateLimitPolicy>> = Object.freeze({
  // 공개된 요청 제한을 확인하지 못했다. 보수적으로 잡는다.
  "mock-server": {
    // Mock 은 외부로 나가지 않으므로 짧아도 된다. 다만 0은 허용하지 않는다.
    minIntervalSeconds: 1,
    backoffSeconds: [1, 2, 4],
    maxConsecutiveFailures: 5,
    basis: "conservative_default",
  },
  "official-approved (stub)": {
    minIntervalSeconds: 60,
    backoffSeconds: [60, 120, 300, 600],
    maxConsecutiveFailures: 3,
    basis: "conservative_default",
  },
  unavailable: {
    minIntervalSeconds: 3600,
    backoffSeconds: [3600],
    maxConsecutiveFailures: 1,
    basis: "conservative_default",
  },
});

const FALLBACK: RateLimitPolicy = {
  minIntervalSeconds: 300,
  backoffSeconds: [300, 600, 1800],
  maxConsecutiveFailures: 3,
  basis: "conservative_default",
};

export function getRateLimitPolicy(providerName: string): RateLimitPolicy {
  return POLICIES[providerName] ?? FALLBACK;
}

/**
 * 다음 조회 시각. 연속 실패가 많을수록 뒤로 민다.
 * 백오프 단계를 다 쓰면 null 을 돌려주며, 호출자는 작업을 멈춘다.
 */
export function nextCheckAt(
  policy: RateLimitPolicy,
  consecutiveFailures: number,
  now = Date.now(),
): string | null {
  if (consecutiveFailures <= 0) {
    return new Date(now + policy.minIntervalSeconds * 1000).toISOString();
  }
  if (consecutiveFailures > policy.maxConsecutiveFailures) return null;
  const index = Math.min(consecutiveFailures - 1, policy.backoffSeconds.length - 1);
  return new Date(now + policy.backoffSeconds[index] * 1000).toISOString();
}

/** Provider 가 알려준 retryAfter 를 존중하되, 최소 간격 아래로는 내려가지 않는다. */
export function retryAfterToNextCheck(
  policy: RateLimitPolicy,
  retryAfterSeconds: number,
  now = Date.now(),
): string {
  const seconds = Math.max(policy.minIntervalSeconds, Math.floor(retryAfterSeconds) || 0);
  return new Date(now + seconds * 1000).toISOString();
}
