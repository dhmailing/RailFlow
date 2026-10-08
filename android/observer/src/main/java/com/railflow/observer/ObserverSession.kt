package com.railflow.observer

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 관찰이 멈춘 이유. */
enum class StopReason {
    USER_STOPPED,
    SERVICE_DISCONNECTED,
    ACCESS_RESTRICTED,
    NOT_STARTED,
}

data class ObserverState(
    /** 접근성 서비스가 연결돼 있는가. 권한 허용 여부와 같지 않다. */
    val serviceConnected: Boolean = false,
    /** 사용자가 시작한 관찰 세션이 진행 중인가. */
    val sessionActive: Boolean = false,
    val startedAtMillis: Long? = null,
    val stoppedReason: StopReason? = StopReason.NOT_STARTED,
    /** 확인된 대상 앱 패키지. 비어 있으면 아무 화면도 처리하지 않는다. */
    val targetPackages: Set<String> = emptySet(),
    val lastResult: ObservationResult? = null,
    /** 세션 동안 읽기를 시도한 횟수와 성공 횟수. */
    val attempts: Int = 0,
    val reads: Int = 0,
)

/**
 * 관찰 세션 상태.
 *
 * 접근성 서비스는 **이 객체가 active 일 때만** 노드를 읽는다. 사용자가
 * 중단하거나 권한이 해제되면 즉시 멈춘다. 반복 조회(폴링)는 없다 --
 * 화면이 바뀔 때 들어오는 사건만 처리한다.
 */
object ObserverSession {

    private val _state = MutableStateFlow(ObserverState())
    val state: StateFlow<ObserverState> = _state.asStateFlow()

    fun start(targetPackages: Set<String>, nowMillis: Long) {
        _state.value = _state.value.copy(
            sessionActive = true,
            startedAtMillis = nowMillis,
            stoppedReason = null,
            targetPackages = targetPackages,
            lastResult = null,
            attempts = 0,
            reads = 0,
        )
    }

    fun stop(reason: StopReason) {
        if (!_state.value.sessionActive && _state.value.stoppedReason != null) return
        _state.value = _state.value.copy(sessionActive = false, stoppedReason = reason)
    }

    fun onServiceConnected() {
        _state.value = _state.value.copy(serviceConnected = true)
    }

    /** 권한 해제·서비스 종료. 진행 중이던 세션은 즉시 멈춘다. */
    fun onServiceDisconnected() {
        _state.value = _state.value.copy(
            serviceConnected = false,
            sessionActive = false,
            stoppedReason = StopReason.SERVICE_DISCONNECTED,
        )
    }

    fun submit(result: ObservationResult) {
        val current = _state.value
        _state.value = current.copy(
            lastResult = result,
            attempts = current.attempts + 1,
            reads = if (result.readable) current.reads + 1 else current.reads,
        )
    }

    /**
     * 이 화면을 처리해도 되는지. 호출자는 이 결과가 null 일 때만 읽는다.
     * null 이 아니면 그 이유가 곧 읽기 불가 사유다.
     */
    fun blockReason(packageName: String?): NotReadableReason? {
        val current = _state.value
        return when {
            !current.sessionActive -> NotReadableReason.SESSION_NOT_ACTIVE
            current.targetPackages.isEmpty() -> NotReadableReason.TARGET_PACKAGE_NOT_CONFIGURED
            packageName == null || packageName !in current.targetPackages ->
                NotReadableReason.NOT_TARGET_PACKAGE
            else -> null
        }
    }

    /** 테스트 전용. */
    fun resetForTest() {
        _state.value = ObserverState()
    }
}
