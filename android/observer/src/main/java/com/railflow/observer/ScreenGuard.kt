package com.railflow.observer

/**
 * 처리하면 안 되는 화면을 걸러낸다.
 *
 * 과하게 막는 쪽을 택했다. 검색 결과 화면에 "로그인" 같은 단어가 메뉴로
 * 들어 있으면 그 화면도 건너뛴다. 덜 막는 것보다 더 막는 것이 낫다.
 */
object ScreenGuard {

    /** 이 단어가 화면에 보이면 처리하지 않는다. */
    private val SENSITIVE_KEYWORDS: List<String> = listOf(
        "비밀번호", "password", "passwd", "로그인", "log in", "sign in", "login",
        "인증번호", "인증 번호", "otp", "일회용", "본인확인", "본인 확인",
        "결제", "payment", "카드번호", "카드 번호", "card number", "cvc", "cvv",
        "유효기간", "계좌", "주민등록", "생년월일", "개인정보", "회원정보",
        "아이디", "이메일 주소", "휴대폰 번호",
    )

    /**
     * 화면을 건너뛸지 판단한다.
     *
     * 세 가지 중 하나라도 걸리면 건너뛴다.
     *  1. 비밀번호 필드가 있다.
     *  2. 편집 가능한 입력창이 있다(검색 결과 화면에는 보통 없다).
     *  3. 민감 단어가 보인다.
     */
    fun isExcluded(root: ObservedNode): Boolean =
        hasPasswordField(root) || hasEditableField(root) || hasSensitiveKeyword(root)

    fun hasPasswordField(root: ObservedNode): Boolean =
        root.walk().any { it.isPassword }

    fun hasEditableField(root: ObservedNode): Boolean =
        root.walk().any { it.isEditable }

    fun hasSensitiveKeyword(root: ObservedNode): Boolean =
        root.walk().any { node ->
            node.ownTexts().any { text ->
                val lowered = text.lowercase()
                SENSITIVE_KEYWORDS.any { lowered.contains(it) }
            }
        }

    /** 화면을 건너뛴 이유를 사람이 읽을 수 있게. 화면 원문은 넣지 않는다. */
    fun exclusionDetail(root: ObservedNode): String = when {
        hasPasswordField(root) -> "비밀번호 입력 필드가 있는 화면입니다."
        hasEditableField(root) -> "입력창이 있는 화면입니다."
        hasSensitiveKeyword(root) -> "로그인·결제·개인정보 관련 화면으로 보입니다."
        else -> "제외 대상이 아닙니다."
    }
}
