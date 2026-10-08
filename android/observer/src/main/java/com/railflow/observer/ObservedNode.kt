package com.railflow.observer

/**
 * 접근성 노드에서 **읽기만 한** 값을 담는 순수 자료구조.
 *
 * AccessibilityNodeInfo 를 직접 쓰지 않는 이유는 두 가지다.
 *  1. 단위 테스트에서 Android 없이 파싱 규칙을 검증할 수 있다.
 *  2. 서비스가 노드에서 **무엇을 꺼냈는지**가 타입으로 드러난다. 화면 전체
 *     원문이나 스크린샷은 이 구조에 들어갈 자리가 없다.
 */
data class ObservedNode(
    val text: String? = null,
    val contentDescription: String? = null,
    val className: String? = null,
    val isPassword: Boolean = false,
    val isEditable: Boolean = false,
    val children: List<ObservedNode> = emptyList(),
) {
    /** 이 노드가 들고 있는 사람이 읽는 문구. 자식은 포함하지 않는다. */
    fun ownTexts(): List<String> =
        listOfNotNull(text, contentDescription).map { it.trim() }.filter { it.isNotEmpty() }

    fun walk(): Sequence<ObservedNode> = sequence {
        yield(this@ObservedNode)
        for (child in children) yieldAll(child.walk())
    }
}
