package com.railflow.android

/**
 * 화면 확인용 가상 열차.
 *
 * **실제 운행과 무관하다.** 출처가 [CandidateSource.DEMO_DATA] 로 고정돼 있어
 * 화면에 항상 "가상 데이터"로 표시된다.
 */
object DemoCandidates {

    fun forCondition(condition: BookingCondition): List<CandidateTrain> = listOf(
        CandidateTrain(
            id = "demo-1",
            trainLabel = "KTX 101",
            departAt = "08:05",
            arriveAt = "10:35",
            source = CandidateSource.DEMO_DATA,
        ),
        CandidateTrain(
            id = "demo-2",
            trainLabel = "SRT 357",
            departAt = "09:10",
            arriveAt = "11:40",
            source = CandidateSource.DEMO_DATA,
        ),
        CandidateTrain(
            id = "demo-3",
            trainLabel = "무궁화 1234",
            departAt = "11:20",
            arriveAt = "15:05",
            source = CandidateSource.DEMO_DATA,
        ),
    ).filter { candidate -> withinRequestedTime(candidate.departAt, condition) }

    /** 희망 시간 범위가 비어 있으면 전부 통과시킨다. */
    fun withinRequestedTime(departAt: String, condition: BookingCondition): Boolean {
        val from = condition.timeFrom.takeIf { it.isNotBlank() }
        val to = condition.timeTo.takeIf { it.isNotBlank() }
        if (from != null && departAt < from) return false
        if (to != null && departAt > to) return false
        return true
    }
}
