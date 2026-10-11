package com.railflow.observer

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 읽기 전용 관찰 서비스.
 *
 * **이 서비스는 아무것도 조작하지 않는다.** performAction, performGlobalAction,
 * dispatchGesture 를 호출하는 코드가 이 파일에 없다. 그것이 ADR 0003 로
 * 폐기한 "공식 화면 조작"과 이 실험을 가르는 지점이다(android/CLAUDE.md §3).
 *
 * 동작 조건:
 *  - 사용자가 앱에서 관찰 세션을 시작했다.
 *  - 사건이 확인된 대상 앱 패키지에서 왔다.
 *  - 그 화면이 로그인·결제·개인정보 화면이 아니다.
 *
 * 위 조건 중 하나라도 어긋나면 노드를 **읽지 않고** 그 이유만 기록한다.
 */
class RailObserverService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        ObserverSession.onServiceConnected()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        ObserverSession.onServiceDisconnected()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        ObserverSession.onServiceDisconnected()
        super.onDestroy()
    }

    override fun onInterrupt() {
        ObserverSession.stop(StopReason.SERVICE_DISCONNECTED)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val now = System.currentTimeMillis()
        val packageName = event?.packageName?.toString()

        val blocked = ObserverSession.blockReason(packageName)
        if (blocked != null) {
            // 세션이 없거나 대상 앱이 아니면 노드를 아예 읽지 않는다.
            if (blocked != NotReadableReason.SESSION_NOT_ACTIVE) {
                ObserverSession.submit(ObservationResult.notReadable(blocked, now, packageName))
            }
            return
        }

        val root: AccessibilityNodeInfo = rootInActiveWindow ?: run {
            ObserverSession.submit(
                ObservationResult.notReadable(NotReadableReason.NO_TRAIN_INFO_IN_NODES, now, packageName),
            )
            return
        }

        val snapshot = try {
            snapshot(root, depth = 0)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }

        ObserverSession.submit(TrainRowParser.parseScreen(snapshot, now, packageName))
    }

    /**
     * 노드 트리를 읽기만 해서 [ObservedNode] 로 옮긴다.
     *
     * 깊이에 상한을 둔다. 화면 전체 원문을 저장하지 않으며, 옮긴 값은 앱
     * 메모리에만 있고 파일이나 네트워크로 나가지 않는다.
     */
    private fun snapshot(node: AccessibilityNodeInfo, depth: Int): ObservedNode {
        val children = if (depth >= MAX_DEPTH) {
            emptyList()
        } else {
            (0 until node.childCount).mapNotNull { index ->
                node.getChild(index)?.let { child ->
                    try {
                        snapshot(child, depth + 1)
                    } finally {
                        @Suppress("DEPRECATION")
                        child.recycle()
                    }
                }
            }
        }
        return ObservedNode(
            text = node.text?.toString(),
            contentDescription = node.contentDescription?.toString(),
            className = node.className?.toString(),
            isPassword = node.isPassword,
            isEditable = node.isEditable,
            children = children,
        )
    }

    private companion object {
        const val MAX_DEPTH = 40
    }
}
