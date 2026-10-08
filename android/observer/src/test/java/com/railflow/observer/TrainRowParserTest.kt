package com.railflow.observer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 노드 트리를 짧게 쓰기 위한 도우미. */
private fun row(vararg texts: String, children: List<ObservedNode> = emptyList()) =
    ObservedNode(
        className = "android.widget.LinearLayout",
        children = texts.map { ObservedNode(text = it, className = "android.widget.TextView") } + children,
    )

private fun screen(vararg rows: ObservedNode) =
    ObservedNode(className = "android.widget.FrameLayout", children = rows.toList())

class TrainRowParserTest {

    @Test
    fun `열차 식별자를 알아본다`() {
        for (label in listOf("KTX 101", "KTX-산천 505", "SRT 357", "무궁화 1234", "제1234호", "1234호")) {
            assertTrue(label, TrainRowParser.isTrainLabel(label))
        }
    }

    @Test
    fun `열차 식별자가 아닌 것을 열차로 보지 않는다`() {
        for (text in listOf("08:05", "2026-10-10", "일반실 매진", "동탄", "45,000원", "", "1")) {
            assertFalse(text, TrainRowParser.isTrainLabel(text))
        }
    }

    @Test
    fun `서로 다른 열차의 번호와 좌석 문구를 합치지 않는다`() {
        val result = TrainRowParser.parseScreen(
            screen(
                row("KTX 101", "08:05", "10:35", "일반실 매진", "특실 예약가능"),
                row("SRT 357", "09:10", "11:40", "일반실 3석", "특실 매진"),
            ),
            atMillis = 1_000L,
            sourcePackage = "com.example.rail",
        )

        assertTrue(result.readable)
        assertEquals(2, result.trains.size)

        val first = result.trains[0]
        assertEquals("KTX 101", first.trainLabel)
        assertEquals("08:05", first.departAt)
        assertEquals(SeatState.SOLD_OUT, first.generalSeat)
        assertEquals(SeatState.AVAILABLE, first.specialSeat)
        // 두 번째 열차의 문구가 첫 번째에 섞이지 않는다.
        assertFalse(first.seatLabels.any { it.contains("3석") })

        val second = result.trains[1]
        assertEquals("SRT 357", second.trainLabel)
        assertEquals("09:10", second.departAt)
        assertEquals(SeatState.AVAILABLE, second.generalSeat)
        assertEquals(SeatState.SOLD_OUT, second.specialSeat)
        assertFalse(second.seatLabels.any { it.contains("예약가능") })
    }

    @Test
    fun `좌석 문구가 없으면 매진이 아니라 상태 불명이다`() {
        val result = TrainRowParser.parseScreen(
            screen(row("KTX 101", "08:05", "10:35")),
            atMillis = 1L,
            sourcePackage = "com.example.rail",
        )
        assertTrue(result.readable)
        val train = result.trains.single()
        assertEquals(SeatState.UNKNOWN, train.generalSeat)
        assertEquals(SeatState.UNKNOWN, train.specialSeat)
        assertTrue(train.seatLabels.isEmpty())
    }

    @Test
    fun `한 등급의 문구만 있으면 다른 등급은 상태 불명이다`() {
        val result = TrainRowParser.parseScreen(
            screen(row("KTX 101", "08:05", "일반실 매진")),
            atMillis = 1L,
            sourcePackage = "com.example.rail",
        )
        val train = result.trains.single()
        assertEquals(SeatState.SOLD_OUT, train.generalSeat)
        assertEquals(SeatState.UNKNOWN, train.specialSeat)
    }

    @Test
    fun `해석할 수 없는 좌석 문구는 상태 불명이다`() {
        assertEquals(SeatState.UNKNOWN, TrainRowParser.seatStateFor(listOf("일반실 확인중"), "일반실"))
        assertEquals(SeatState.UNKNOWN, TrainRowParser.seatStateFor(listOf("일반실"), "일반실"))
        assertEquals(SeatState.UNKNOWN, TrainRowParser.seatStateFor(emptyList(), "일반실"))
    }

    @Test
    fun `시각이 없으면 null 로 둔다`() {
        val train = TrainRowParser.parseRow(row("SRT 357", "일반실 매진"))
        assertEquals("SRT 357", train?.trainLabel)
        assertNull(train?.departAt)
        assertNull(train?.arriveAt)
    }

    @Test
    fun `중첩이 깊어도 열차별 최소 행을 찾는다`() {
        val nested = ObservedNode(
            children = listOf(
                ObservedNode(
                    children = listOf(
                        row("KTX 101", "08:05", "일반실 매진"),
                        row("SRT 357", "09:10", "일반실 2석"),
                    ),
                ),
            ),
        )
        val rows = TrainRowParser.findRows(nested)
        assertEquals(2, rows.size)
        assertEquals(1, TrainRowParser.parseRow(rows[0])!!.seatLabels.size)
    }

    @Test
    fun `열차 정보가 없으면 읽기 불가로 보고한다`() {
        val result = TrainRowParser.parseScreen(
            screen(row("검색 결과가 없습니다")),
            atMillis = 7L,
            sourcePackage = "com.example.rail",
        )
        assertFalse(result.readable)
        assertEquals(NotReadableReason.NO_TRAIN_INFO_IN_NODES, result.reason)
        assertTrue(result.trains.isEmpty())
    }
}
