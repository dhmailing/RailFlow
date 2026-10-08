package com.railflow.android

import kotlinx.serialization.Serializable

/** 좌석등급 선택. 웹과 같은 세 가지다. */
@Serializable
enum class SeatClassChoice(val label: String) {
    GENERAL_ONLY("일반실만"),
    SPECIAL_ONLY("특실만"),
    BOTH("일반실·특실 모두"),
}

/**
 * 후보 열차의 출처.
 *
 * **직접 입력한 열차를 검증된 실제 열차로 취급하지 않는다.** [verifiedReal] 이
 * 그 구분을 코드로 들고 있다.
 */
@Serializable
enum class CandidateSource(val label: String, val verifiedReal: Boolean, val note: String) {
    REAL_TIMETABLE("실제 시간표", true, "공공데이터 시간표에서 가져온 열차입니다."),
    DEMO_DATA("가상 데이터", false, "화면 확인용으로 만든 가상 열차입니다. 실제 운행과 무관합니다."),
    MANUAL_INPUT("직접 입력", false, "사용자가 직접 적은 값입니다. 실제 운행 여부를 확인하지 않았습니다."),
    OBSERVED_OFFICIAL("공식 화면에서 관찰", false, "공식 앱 화면에서 읽은 값입니다. 읽은 시각의 표시입니다."),
}

/** 좌석 확인 상태. 앱이 확인한 것과 추정한 것을 섞지 않는다. */
@Serializable
enum class SeatCheckState(val label: String) {
    NOT_CHECKED("좌석 미확인"),
    OBSERVED_AVAILABLE("관찰: 좌석 있음"),
    OBSERVED_SOLD_OUT("관찰: 매진"),
    OBSERVED_UNKNOWN("관찰: 상태 불명"),
}

@Serializable
data class CandidateTrain(
    val id: String,
    val trainLabel: String,
    val departAt: String,
    val arriveAt: String,
    val source: CandidateSource,
    val selected: Boolean = false,
    val seatCheck: SeatCheckState = SeatCheckState.NOT_CHECKED,
    /** 관찰로 좌석을 확인한 시각. 확인하지 않았으면 null. */
    val seatCheckedAtMillis: Long? = null,
)

@Serializable
data class BookingCondition(
    val departure: String = "동탄",
    val arrival: String = "울산(통도사)",
    val date: String = "",
    val timeFrom: String = "",
    val timeTo: String = "",
    val passengers: Int = 1,
    val seatClass: SeatClassChoice = SeatClassChoice.BOTH,
) {
    /** 비어 있으면 안 되는 값이 채워졌는가. */
    fun isComplete(): Boolean =
        departure.isNotBlank() && arrival.isNotBlank() && date.isNotBlank() && passengers >= 1
}

/**
 * 앱이 저장하는 전부.
 *
 * 철도 계정 비밀번호·OTP·쿠키·세션을 담는 자리가 **없다.** 필드를 추가할
 * 때도 넣지 않는다(android/CLAUDE.md §2).
 */
@Serializable
data class AppState(
    val condition: BookingCondition = BookingCondition(),
    val candidates: List<CandidateTrain> = emptyList(),
    /** 사용자가 확인해 준 대상 앱 패키지. 이름으로 추측해 넣지 않는다. */
    val targetPackages: List<String> = emptyList(),
    val schemaVersion: Int = 1,
) {
    val selectedCandidates: List<CandidateTrain> get() = candidates.filter { it.selected }
}
