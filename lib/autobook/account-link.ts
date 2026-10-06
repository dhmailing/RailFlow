import "server-only";

import { AutobookError, type AccountLinkStatus } from "@/lib/autobook/types";

// 계정 연결.
//
// **이번 단계에서 RailFlow는 코레일 계정 비밀번호를 저장하지 않는다.**
//
// 우선순위(지침 §6):
//   1. 공식 OAuth·파트너 토큰
//   2. 제한된 권한의 공식 API credential
//   3. 사용자가 직접 갱신하는 단기 세션
//   4. 위가 모두 없으면 실제 Provider 미구현
//
// 현재 확인 결과: 1·2·3 중 어느 것도 공개 문서에서 확인하지 못했다
// (docs/V0.9-KORAIL-INTEGRATION-RESEARCH.md). 따라서 4번이다.
//
// 이 모듈은 "연결 UI와 저장소 인터페이스는 만들되, 실제 자격증명 입력·저장은
// 비활성화"를 코드로 표현한다. 비밀번호를 받는 함수 자체가 없다.

/** 지원 가능한 연결 방식. 비밀번호는 목록에 없다 -- 의도적이다. */
export type AccountLinkMethod = "official_oauth" | "official_api_credential" | "short_lived_session";

/**
 * 한 연결 방식의 가용성. **모든 필드가 readonly 다.** 화면이 이 값을 그대로
 * 읽으므로, 외부에서 고칠 수 있으면 "계정 연결 가능"이라는 거짓 표시가 된다.
 */
export type AccountLinkMethodAvailability = {
  readonly available: boolean;
  readonly blockedReason: string;
};

/** 각 방식이 지금 쓸 수 있는지. 전부 false 인 것이 현재 상태다. */
export const METHOD_AVAILABILITY: Readonly<Record<AccountLinkMethod, AccountLinkMethodAvailability>> =
  Object.freeze({
    official_oauth: Object.freeze({
      available: false,
      blockedReason: "코레일 공식 OAuth·파트너 토큰 발급 창구를 확인하지 못했습니다.",
    }),
    official_api_credential: Object.freeze({
      available: false,
      blockedReason: "좌석 조회·예약 생성을 포함하는 공식 API credential 을 확인하지 못했습니다.",
    }),
    short_lived_session: Object.freeze({
      available: false,
      blockedReason:
        "사용자가 직접 갱신하는 단기 세션 방식도 공식 허용 근거를 확인하지 못했습니다. 별도 사용자 승인 전까지 비활성화합니다.",
    }),
  });

export interface AccountLinkStore {
  getStatus(userId: string): Promise<AccountLinkStatus>;
  /**
   * 연결을 시작한다. **공식 방식이 열려 있을 때만 호출될 수 있다.**
   * 지금은 어떤 방식도 available 이 아니므로 항상 거부된다.
   */
  beginLink(input: { userId: string; method: AccountLinkMethod }): Promise<never>;
  unlink(userId: string): Promise<void>;
}

const statuses = new Map<string, AccountLinkStatus>();

export function createMemoryAccountLinkStore(): AccountLinkStore {
  return {
    async getStatus(userId) {
      return (
        statuses.get(userId) ?? { kind: "NOT_LINKED", reason: "OFFICIAL_METHOD_UNAVAILABLE" }
      );
    },

    async beginLink({ method }) {
      const availability = METHOD_AVAILABILITY[method];
      if (!availability) {
        throw new AutobookError("INVALID_INPUT", `알 수 없는 연결 방식입니다: ${method}`);
      }
      // 여기에 "비밀번호를 받아서 저장"하는 분기는 존재하지 않는다.
      throw new AutobookError("ACCOUNT_LINK_REQUIRED", availability.blockedReason);
    },

    async unlink(userId) {
      statuses.delete(userId);
    },
  };
}

/** 테스트 전용. */
export function resetAccountLinkStore(): void {
  statuses.clear();
}

/** 화면에 내보내는 계정 연결 가용성 요약. 전부 readonly 다. */
export type AccountLinkAvailability = {
  readonly anyAvailable: boolean;
  readonly methods: readonly (AccountLinkMethodAvailability & { readonly method: AccountLinkMethod })[];
  readonly summary: string;
};

// 내용이 상수이므로 호출마다 만들지 않고 한 번 만들어 freeze 한다.
// 완전히 불변이면 공유해도 외부에서 표시를 바꿀 수 없다.
const AVAILABILITY: AccountLinkAvailability = (() => {
  const methods = Object.freeze(
    (Object.keys(METHOD_AVAILABILITY) as AccountLinkMethod[]).map((method) =>
      Object.freeze({ method, ...METHOD_AVAILABILITY[method] }),
    ),
  );
  return Object.freeze({
    anyAvailable: methods.some((m) => m.available),
    methods,
    // 이 문장이 화면에 그대로 나간다.
    summary:
      "공식 계정 연결 방식이 아직 확인되지 않아 계정 연결을 활성화하지 않았습니다. " +
      "RailFlow는 코레일 계정 비밀번호를 입력받지도, 저장하지도 않습니다.",
  });
})();

/**
 * 지금 계정 연결이 가능한지 요약. 화면이 "무엇이 없어서 못 하는지"를
 * 그대로 보여줄 수 있어야 한다.
 *
 * 반환값은 **완전히 불변**이다. 호출자가 돌려받은 값을 고쳐 "가능"으로
 * 바꿀 수 없다(CLAUDE.md 「현재 목표(v0.3)」 4번).
 */
export function accountLinkAvailability(): AccountLinkAvailability {
  return AVAILABILITY;
}
