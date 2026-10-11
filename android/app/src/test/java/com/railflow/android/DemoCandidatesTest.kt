package com.railflow.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoCandidatesTest {

    @Test
    fun `가상 데이터는 항상 가상으로 표시된다`() {
        val candidates = DemoCandidates.forCondition(BookingCondition(date = "2026-10-10"))
        assertTrue(candidates.isNotEmpty())
        assertTrue(candidates.all { it.source == CandidateSource.DEMO_DATA })
        assertTrue(candidates.none { it.source.verifiedReal })
    }

    @Test
    fun `희망 시간 범위를 지키면 그 범위의 열차만 남는다`() {
        val condition = BookingCondition(date = "2026-10-10", timeFrom = "09:00", timeTo = "10:00")
        val candidates = DemoCandidates.forCondition(condition)
        assertEquals(listOf("SRT 357"), candidates.map { it.trainLabel })
    }

    @Test
    fun `희망 시간을 비우면 전부 남는다`() {
        val candidates = DemoCandidates.forCondition(BookingCondition(date = "2026-10-10"))
        assertEquals(3, candidates.size)
    }

    @Test
    fun `시작 시각만 넣어도 동작한다`() {
        val condition = BookingCondition(date = "2026-10-10", timeFrom = "10:00")
        assertFalse(DemoCandidates.withinRequestedTime("08:05", condition))
        assertTrue(DemoCandidates.withinRequestedTime("11:20", condition))
    }

    @Test
    fun `가상 데이터에는 좌석 확인 상태가 없다`() {
        val candidates = DemoCandidates.forCondition(BookingCondition(date = "2026-10-10"))
        assertTrue(candidates.all { it.seatCheck == SeatCheckState.NOT_CHECKED })
        assertTrue(candidates.all { it.seatCheckedAtMillis == null })
    }
}
