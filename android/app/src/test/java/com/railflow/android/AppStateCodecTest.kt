package com.railflow.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStateCodecTest {

    private fun sampleState() = AppState(
        condition = BookingCondition(
            departure = "동탄",
            arrival = "울산(통도사)",
            date = "2026-10-10",
            timeFrom = "08:00",
            timeTo = "12:00",
            passengers = 2,
            seatClass = SeatClassChoice.SPECIAL_ONLY,
        ),
        candidates = listOf(
            CandidateTrain(
                id = "demo-1",
                trainLabel = "KTX 101",
                departAt = "08:05",
                arriveAt = "10:35",
                source = CandidateSource.DEMO_DATA,
                selected = true,
            ),
            CandidateTrain(
                id = "manual-1",
                trainLabel = "SRT 357",
                departAt = "09:10",
                arriveAt = "11:40",
                source = CandidateSource.MANUAL_INPUT,
                seatCheck = SeatCheckState.OBSERVED_UNKNOWN,
                seatCheckedAtMillis = 1_700_000_000_000L,
            ),
        ),
        targetPackages = listOf("com.example.rail"),
    )

    @Test
    fun `조건과 후보가 그대로 복원된다`() {
        val restored = AppStateCodec.decode(AppStateCodec.encode(sampleState()))
        assertEquals(sampleState(), restored)
    }

    @Test
    fun `좌석등급이 복원 후에도 유지된다`() {
        for (choice in SeatClassChoice.entries) {
            val state = AppState(condition = BookingCondition(date = "2026-10-10", seatClass = choice))
            val restored = AppStateCodec.decode(AppStateCodec.encode(state))
            assertEquals(choice, restored.condition.seatClass)
        }
    }

    @Test
    fun `후보 출처가 복원 후에도 유지된다`() {
        for (source in CandidateSource.entries) {
            val state = AppState(
                candidates = listOf(
                    CandidateTrain("id-$source", "KTX 101", "08:05", "10:35", source),
                ),
            )
            val restored = AppStateCodec.decode(AppStateCodec.encode(state))
            assertEquals(source, restored.candidates.single().source)
            assertEquals(source.verifiedReal, restored.candidates.single().source.verifiedReal)
        }
    }

    @Test
    fun `선택 상태와 좌석 확인 시각이 유지된다`() {
        val restored = AppStateCodec.decode(AppStateCodec.encode(sampleState()))
        assertTrue(restored.candidates[0].selected)
        assertEquals(1, restored.selectedCandidates.size)
        assertEquals(1_700_000_000_000L, restored.candidates[1].seatCheckedAtMillis)
        assertEquals(SeatCheckState.OBSERVED_UNKNOWN, restored.candidates[1].seatCheck)
    }

    @Test
    fun `대상 앱 패키지가 유지된다`() {
        val restored = AppStateCodec.decode(AppStateCodec.encode(sampleState()))
        assertEquals(listOf("com.example.rail"), restored.targetPackages)
    }

    @Test
    fun `비었거나 깨진 값은 기본 상태가 된다`() {
        assertEquals(AppState(), AppStateCodec.decode(null))
        assertEquals(AppState(), AppStateCodec.decode(""))
        assertEquals(AppState(), AppStateCodec.decode("   "))
        assertEquals(AppState(), AppStateCodec.decode("{ 깨진 json"))
        assertEquals(AppState(), AppStateCodec.decode("[1,2,3]"))
    }

    @Test
    fun `저장 형식에 자격증명 필드가 없다`() {
        val encoded = AppStateCodec.encode(sampleState())
        for (word in listOf("password", "passwd", "cookie", "session", "otp", "token", "card")) {
            assertFalse("저장 형식에 $word 가 있다", encoded.lowercase().contains(word))
        }
    }

    @Test
    fun `직접 입력한 열차는 검증된 실제 열차가 아니다`() {
        assertFalse(CandidateSource.MANUAL_INPUT.verifiedReal)
        assertFalse(CandidateSource.DEMO_DATA.verifiedReal)
        assertFalse(CandidateSource.OBSERVED_OFFICIAL.verifiedReal)
        assertTrue(CandidateSource.REAL_TIMETABLE.verifiedReal)
    }

    @Test
    fun `좌석 확인은 기본적으로 미확인이다`() {
        val candidate = CandidateTrain("id", "KTX 101", "08:05", "10:35", CandidateSource.MANUAL_INPUT)
        assertEquals(SeatCheckState.NOT_CHECKED, candidate.seatCheck)
        assertNull(candidate.seatCheckedAtMillis)
    }
}
