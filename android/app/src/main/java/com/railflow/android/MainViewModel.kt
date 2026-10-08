package com.railflow.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.railflow.observer.ObservationResult
import com.railflow.observer.ObserverSession
import com.railflow.observer.ObserverState
import com.railflow.observer.SeatState
import com.railflow.observer.StopReason
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** 어떤 탭을 보고 있는가. 웹과 같은 3개다. */
enum class Tab(val label: String) {
    BOOKING("예매"),
    AUTOBOOK("자동예약"),
    SETTINGS("마이페이지"),
}

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = AppStateRepository(application)

    private val _appState = MutableStateFlow(AppState())
    val appState: StateFlow<AppState> = _appState.asStateFlow()

    private val _tab = MutableStateFlow(Tab.BOOKING)
    val tab: StateFlow<Tab> = _tab.asStateFlow()

    private val _diagnosticsOpen = MutableStateFlow(false)
    val diagnosticsOpen: StateFlow<Boolean> = _diagnosticsOpen.asStateFlow()

    val observerState: StateFlow<ObserverState> = ObserverSession.state

    init {
        viewModelScope.launch {
            // 저장된 조건·후보를 복원한다. 앱을 다시 켜도 유지된다.
            repository.state.collect { restored -> _appState.value = restored }
        }
    }

    private fun update(transform: (AppState) -> AppState) {
        val next = transform(_appState.value)
        _appState.value = next
        viewModelScope.launch { repository.save(next) }
    }

    fun selectTab(tab: Tab) {
        _tab.value = tab
    }

    fun openDiagnostics(open: Boolean) {
        _diagnosticsOpen.value = open
    }

    // --- 조건 ---------------------------------------------------------------

    fun updateCondition(transform: (BookingCondition) -> BookingCondition) =
        update { it.copy(condition = transform(it.condition)) }

    // --- 후보 ---------------------------------------------------------------

    fun loadDemoCandidates() = update { state ->
        val demo = DemoCandidates.forCondition(state.condition)
        // 같은 id 가 이미 있으면 선택 상태를 유지한다.
        val existing = state.candidates.associateBy { it.id }
        val merged = demo.map { candidate ->
            existing[candidate.id]?.let { candidate.copy(selected = it.selected, seatCheck = it.seatCheck) }
                ?: candidate
        }
        val others = state.candidates.filter { it.source != CandidateSource.DEMO_DATA }
        state.copy(candidates = others + merged)
    }

    fun addManualCandidate(trainLabel: String, departAt: String, arriveAt: String) {
        if (trainLabel.isBlank()) return
        update { state ->
            val candidate = CandidateTrain(
                id = "manual-${System.currentTimeMillis()}",
                trainLabel = trainLabel.trim(),
                departAt = departAt.trim(),
                arriveAt = arriveAt.trim(),
                // 직접 입력은 검증된 실제 열차가 아니다.
                source = CandidateSource.MANUAL_INPUT,
            )
            state.copy(candidates = state.candidates + candidate)
        }
    }

    fun toggleCandidate(id: String) = update { state ->
        state.copy(
            candidates = state.candidates.map { candidate ->
                if (candidate.id == id) candidate.copy(selected = !candidate.selected) else candidate
            },
        )
    }

    fun removeCandidate(id: String) = update { state ->
        state.copy(candidates = state.candidates.filterNot { it.id == id })
    }

    // --- 대상 앱 패키지 -----------------------------------------------------

    fun addTargetPackage(packageName: String) {
        val trimmed = packageName.trim()
        if (trimmed.isBlank() || trimmed in _appState.value.targetPackages) return
        update { it.copy(targetPackages = it.targetPackages + trimmed) }
    }

    fun removeTargetPackage(packageName: String) =
        update { it.copy(targetPackages = it.targetPackages.filterNot { item -> item == packageName }) }

    // --- 관찰 ---------------------------------------------------------------

    /** 사용자가 직접 시작한다. 반복 조회는 없다. */
    fun startObservation() {
        ObserverSession.start(
            targetPackages = _appState.value.targetPackages.toSet(),
            nowMillis = System.currentTimeMillis(),
        )
    }

    /** 진단용. 대상 앱을 이 앱 자신으로 두고 자체 화면을 읽는다. */
    fun startSelfDiagnostics() {
        ObserverSession.start(
            targetPackages = setOf(getApplication<Application>().packageName),
            nowMillis = System.currentTimeMillis(),
        )
    }

    fun stopObservation() {
        ObserverSession.stop(StopReason.USER_STOPPED)
        Notifications.observationStopped(getApplication<Application>(), "사용자가 관찰을 중단했습니다.")
    }

    /**
     * 관찰 결과를 후보의 좌석 확인 상태에 반영한다.
     *
     * 열차 식별자가 후보와 정확히 일치할 때만 반영한다. 비슷한 번호를
     * 끌어다 맞추지 않는다. 상태 불명은 불명으로 적는다.
     */
    fun applyObservation(result: ObservationResult) {
        if (!result.readable) return
        update { state ->
            state.copy(
                candidates = state.candidates.map { candidate ->
                    val observed = result.trains.firstOrNull { it.trainLabel == candidate.trainLabel }
                        ?: return@map candidate
                    candidate.copy(
                        seatCheck = seatCheckFor(observed.generalSeat, observed.specialSeat, state.condition.seatClass),
                        seatCheckedAtMillis = result.observedAtMillis,
                    )
                },
            )
        }
        Notifications.observationRead(
            getApplication<Application>(),
            result.trains.joinToString("\n") { train ->
                "${train.trainLabel} ${train.departAt ?: "시각 불명"} · 일반실 ${label(train.generalSeat)} · 특실 ${label(train.specialSeat)}"
            },
        )
    }

    suspend fun clearLocalData() {
        repository.clear()
        _appState.value = AppState()
    }

    companion object {
        fun label(state: SeatState): String = when (state) {
            SeatState.AVAILABLE -> "좌석 있음"
            SeatState.SOLD_OUT -> "매진"
            SeatState.UNKNOWN -> "상태 불명"
        }

        /**
         * 사용자가 고른 좌석등급만 본다. 고르지 않은 등급의 상태로
         * 결론을 바꾸지 않는다.
         */
        fun seatCheckFor(
            general: SeatState,
            special: SeatState,
            choice: SeatClassChoice,
        ): SeatCheckState {
            val relevant = when (choice) {
                SeatClassChoice.GENERAL_ONLY -> listOf(general)
                SeatClassChoice.SPECIAL_ONLY -> listOf(special)
                SeatClassChoice.BOTH -> listOf(general, special)
            }
            return when {
                relevant.any { it == SeatState.AVAILABLE } -> SeatCheckState.OBSERVED_AVAILABLE
                relevant.all { it == SeatState.SOLD_OUT } -> SeatCheckState.OBSERVED_SOLD_OUT
                else -> SeatCheckState.OBSERVED_UNKNOWN
            }
        }
    }
}
