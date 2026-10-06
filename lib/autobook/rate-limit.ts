import "server-only";

// Provider별 요청 제한과 백오프.
//
// v0.8에서 배운 것: 고정 주기를 지켰는데도 운영자가 자동화로 판정했다.
// 그래서 이번에는 "얼마나 자주"를 우리가 정하지 않는다 -- 공개된 제한을
// 확인한 경우 그 값을 쓰고, 확인하지 못했으면 보수적인 값을 쓴다.
//
// 지수 백오프에는 **상한이 있다.** 상한 없는 재시도는 그 자체가 폭주다.

/**
 * 요청 제한 정책.
 *
 * **모든 필드가 readonly 다.** 정책은 공유 객체이고, 호출자가 돌려받은 값을
 * 고치면 프로세스 전체의 요청 제한이 바뀐다. 최소 간격이 낮아지면 그대로
 * 요청 폭주가 된다. 타입으로 막고(컴파일), freeze 로 막는다(런타임).
 */
export type RateLimitPolicy = {
  /** 이 Provider 에 대한 최소 조회 간격(초). */
  readonly minIntervalSeconds: number;
  /** 429·접근 제한을 만났을 때의 백오프 단계(초). 마지막 값을 넘으면 중단한다. */
  readonly backoffSeconds: readonly number[];
  /** 한 작업이 연속으로 실패할 수 있는 최대 횟수. */
  readonly maxConsecutiveFailures: number;
  /** 이 정책의 근거. "확인됨"이 아니면 보수적인 기본값이라는 뜻이다. */
  readonly basis: "official_documented" | "conservative_default";
};

/**
 * 정책 하나를 완전히 불변으로 만든다. Object.freeze 는 얕으므로
 * backoffSeconds 배열까지 직접 freeze 한다. 사본은 만들지 않는다 --
 * 완전히 불변이면 공유 참조로 충분하다.
 */
function frozenPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  Object.freeze(policy.backoffSeconds);
  return Object.freeze(policy);
}

const POLICIES: Readonly<Record<string, RateLimitPolicy>> = Object.freeze({
  // 공개된 요청 제한을 확인하지 못했다. 보수적으로 잡는다.
  "mock-server": frozenPolicy({
    // Mock 은 외부로 나가지 않으므로 짧아도 된다. 다만 0은 허용하지 않는다.
    minIntervalSeconds: 1,
    backoffSeconds: [1, 2, 4],
    maxConsecutiveFailures: 5,
    basis: "conservative_default",
  }),
  "official-approved (stub)": frozenPolicy({
    minIntervalSeconds: 60,
    backoffSeconds: [60, 120, 300, 600],
    maxConsecutiveFailures: 3,
    basis: "conservative_default",
  }),
  unavailable: frozenPolicy({
    minIntervalSeconds: 3600,
    backoffSeconds: [3600],
    maxConsecutiveFailures: 1,
    basis: "conservative_default",
  }),
});

const FALLBACK: RateLimitPolicy = frozenPolicy({
  minIntervalSeconds: 300,
  backoffSeconds: [300, 600, 1800],
  maxConsecutiveFailures: 3,
  basis: "conservative_default",
});

/**
 * Provider 의 요청 제한 정책. 반환값은 **완전히 불변인 공유 객체**이므로
 * 호출자가 고칠 수 없고, 고칠 수 없으니 사본을 만들 필요도 없다.
 */
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
