package com.railflow.observer

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ObserverSessionTest {

    @Before
    fun setUp() = ObserverSession.resetForTest()

    @After
    fun tearDown() = ObserverSession.resetForTest()

    @Test
    fun `세션을 시작하지 않으면 아무 화면도 처리하지 않는다`() {
        assertEquals(NotReadableReason.SESSION_NOT_ACTIVE, ObserverSession.blockReason("com.example.rail"))
    }

    @Test
    fun `대상 패키지가 확인되지 않으면 처리하지 않는다`() {
        ObserverSession.start(targetPackages = emptySet(), nowMillis = 1L)
        assertEquals(
            NotReadableReason.TARGET_PACKAGE_NOT_CONFIGURED,
            ObserverSession.blockReason("com.example.rail"),
        )
    }

    @Test
    fun `대상 앱이 아닌 화면은 처리하지 않는다`() {
        ObserverSession.start(targetPackages = setOf("com.example.rail"), nowMillis = 1L)
        assertEquals(NotReadableReason.NOT_TARGET_PACKAGE, ObserverSession.blockReason("com.other.app"))
        assertEquals(NotReadableReason.NOT_TARGET_PACKAGE, ObserverSession.blockReason(null))
        assertNull(ObserverSession.blockReason("com.example.rail"))
    }

    @Test
    fun `사용자가 중단하면 즉시 멈춘다`() {
        ObserverSession.start(targetPackages = setOf("com.example.rail"), nowMillis = 1L)
        assertTrue(ObserverSession.state.value.sessionActive)

        ObserverSession.stop(StopReason.USER_STOPPED)

        assertFalse(ObserverSession.state.value.sessionActive)
        assertEquals(StopReason.USER_STOPPED, ObserverSession.state.value.stoppedReason)
        assertEquals(NotReadableReason.SESSION_NOT_ACTIVE, ObserverSession.blockReason("com.example.rail"))
    }

    @Test
    fun `권한이 해제되면 진행 중인 세션이 즉시 멈춘다`() {
        ObserverSession.onServiceConnected()
        ObserverSession.start(targetPackages = setOf("com.example.rail"), nowMillis = 1L)

        ObserverSession.onServiceDisconnected()

        val state = ObserverSession.state.value
        assertFalse(state.serviceConnected)
        assertFalse(state.sessionActive)
        assertEquals(StopReason.SERVICE_DISCONNECTED, state.stoppedReason)
    }

    @Test
    fun `읽기 성공과 시도 횟수를 따로 센다`() {
        ObserverSession.start(targetPackages = setOf("com.example.rail"), nowMillis = 1L)

        ObserverSession.submit(
            ObservationResult.notReadable(NotReadableReason.NO_TRAIN_INFO_IN_NODES, 2L, "com.example.rail"),
        )
        ObserverSession.submit(
            ObservationResult.read(
                listOf(ObservedTrain("KTX 101", "08:05", null, SeatState.UNKNOWN, SeatState.UNKNOWN, emptyList())),
                3L,
                "com.example.rail",
            ),
        )

        val state = ObserverSession.state.value
        assertEquals(2, state.attempts)
        assertEquals(1, state.reads)
        assertTrue(state.lastResult!!.readable)
    }

    @Test
    fun `서비스 연결은 세션 시작과 다르다`() {
        ObserverSession.onServiceConnected()
        assertTrue(ObserverSession.state.value.serviceConnected)
        // 권한이 켜졌다고 해서 관찰이 시작되지는 않는다.
        assertFalse(ObserverSession.state.value.sessionActive)
        assertEquals(NotReadableReason.SESSION_NOT_ACTIVE, ObserverSession.blockReason("com.example.rail"))
    }
}
