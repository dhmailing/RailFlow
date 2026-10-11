package com.railflow.observer

/**
 * 좌석 표시 상태.
 *
 * **UNKNOWN 을 매진이나 예약 가능으로 추정하지 않는다.** 화면에서 읽은 문구가
 * 없거나 해석할 수 없으면 그대로 UNKNOWN 이다.
 */
enum class SeatState {
    AVAILABLE,
    SOLD_OUT,
    UNKNOWN,
}

/** 관찰한 열차 한 편. 같은 행(하위 트리)에서 읽은 값만 들어간다. */
data class ObservedTrain(
    val trainLabel: String,
    val departAt: String?,
    val arriveAt: String?,
    val generalSeat: SeatState,
    val specialSeat: SeatState,
    /** 이 열차 행에서 실제로 읽은 좌석 문구. 다른 행의 문구가 섞이지 않는다. */
    val seatLabels: List<String>,
)

/** 읽지 못한 이유. 읽기 실패를 조회 실패나 매진으로 바꾸지 않는다. */
enum class NotReadableReason {
    /** 사용자가 관찰 세션을 시작하지 않았다. */
    SESSION_NOT_ACTIVE,

    /** 대상 앱 패키지가 아직 확인되지 않았다. 이름으로 추측하지 않는다. */
    TARGET_PACKAGE_NOT_CONFIGURED,

    /** 대상 앱이 아닌 화면이다. */
    NOT_TARGET_PACKAGE,

    /** 로그인·결제·개인정보 화면이다. 처리하지 않는다. */
    EXCLUDED_SCREEN,

    /** 접근성 노드에 열차 정보가 없다. OCR·캡처로 전환하지 않는다. */
    NO_TRAIN_INFO_IN_NODES,
}

data class ObservationResult(
    val readable: Boolean,
    val reason: NotReadableReason?,
    val trains: List<ObservedTrain>,
    val observedAtMillis: Long,
    val sourcePackage: String?,
) {
    companion object {
        fun notReadable(reason: NotReadableReason, atMillis: Long, sourcePackage: String? = null) =
            ObservationResult(false, reason, emptyList(), atMillis, sourcePackage)

        fun read(trains: List<ObservedTrain>, atMillis: Long, sourcePackage: String?) =
            ObservationResult(true, null, trains, atMillis, sourcePackage)
    }
}
