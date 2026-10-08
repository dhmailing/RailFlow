package com.railflow.android

import com.railflow.observer.SeatState
import org.junit.Assert.assertEquals
import org.junit.Test

class SeatCheckTest {

    @Test
    fun `일반실만 고르면 특실 상태로 결론을 바꾸지 않는다`() {
        assertEquals(
            SeatCheckState.OBSERVED_SOLD_OUT,
            MainViewModel.seatCheckFor(SeatState.SOLD_OUT, SeatState.AVAILABLE, SeatClassChoice.GENERAL_ONLY),
        )
    }

    @Test
    fun `특실만 고르면 일반실 상태로 결론을 바꾸지 않는다`() {
        assertEquals(
            SeatCheckState.OBSERVED_SOLD_OUT,
            MainViewModel.seatCheckFor(SeatState.AVAILABLE, SeatState.SOLD_OUT, SeatClassChoice.SPECIAL_ONLY),
        )
    }

    @Test
    fun `둘 다 고르면 한쪽이라도 있으면 좌석 있음이다`() {
        assertEquals(
            SeatCheckState.OBSERVED_AVAILABLE,
            MainViewModel.seatCheckFor(SeatState.SOLD_OUT, SeatState.AVAILABLE, SeatClassChoice.BOTH),
        )
    }

    @Test
    fun `상태 불명을 매진으로 바꾸지 않는다`() {
        assertEquals(
            SeatCheckState.OBSERVED_UNKNOWN,
            MainViewModel.seatCheckFor(SeatState.UNKNOWN, SeatState.UNKNOWN, SeatClassChoice.BOTH),
        )
        assertEquals(
            SeatCheckState.OBSERVED_UNKNOWN,
            MainViewModel.seatCheckFor(SeatState.UNKNOWN, SeatState.SOLD_OUT, SeatClassChoice.BOTH),
        )
        assertEquals(
            SeatCheckState.OBSERVED_UNKNOWN,
            MainViewModel.seatCheckFor(SeatState.UNKNOWN, SeatState.AVAILABLE, SeatClassChoice.GENERAL_ONLY),
        )
    }

    @Test
    fun `표시 문구가 상태와 어긋나지 않는다`() {
        assertEquals("좌석 있음", MainViewModel.label(SeatState.AVAILABLE))
        assertEquals("매진", MainViewModel.label(SeatState.SOLD_OUT))
        assertEquals("상태 불명", MainViewModel.label(SeatState.UNKNOWN))
    }
}
