package com.railflow.observer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenGuardTest {

    private fun node(vararg texts: String) =
        ObservedNode(children = texts.map { ObservedNode(text = it) })

    @Test
    fun `비밀번호 필드가 있으면 처리하지 않는다`() {
        val root = ObservedNode(
            children = listOf(ObservedNode(text = "입력", isPassword = true)),
        )
        assertTrue(ScreenGuard.isExcluded(root))
        assertEquals("비밀번호 입력 필드가 있는 화면입니다.", ScreenGuard.exclusionDetail(root))
    }

    @Test
    fun `입력창이 있으면 처리하지 않는다`() {
        val root = ObservedNode(children = listOf(ObservedNode(text = "검색", isEditable = true)))
        assertTrue(ScreenGuard.isExcluded(root))
    }

    @Test
    fun `로그인 결제 개인정보 단어가 보이면 처리하지 않는다`() {
        for (text in listOf("로그인", "비밀번호 찾기", "결제하기", "카드번호", "인증번호 입력", "개인정보 처리방침", "Sign in")) {
            assertTrue(text, ScreenGuard.isExcluded(node(text)))
        }
    }

    @Test
    fun `검색 결과 화면은 처리한다`() {
        val root = node("KTX 101", "08:05", "10:35", "일반실 매진", "특실 예약가능", "동탄", "울산(통도사)")
        assertFalse(ScreenGuard.isExcluded(root))
    }

    @Test
    fun `민감 화면은 파싱 단계에서도 걸러진다`() {
        val root = ObservedNode(
            children = listOf(
                ObservedNode(text = "KTX 101"),
                ObservedNode(text = "일반실 2석"),
                ObservedNode(text = "결제 수단 선택"),
            ),
        )
        val result = TrainRowParser.parseScreen(root, atMillis = 3L, sourcePackage = "com.example.rail")
        assertFalse(result.readable)
        assertEquals(NotReadableReason.EXCLUDED_SCREEN, result.reason)
        assertTrue(result.trains.isEmpty())
    }
}
