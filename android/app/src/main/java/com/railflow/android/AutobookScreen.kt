package com.railflow.android

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.railflow.android.ui.DisabledFeature
import com.railflow.android.ui.Hint
import com.railflow.android.ui.RailCard
import com.railflow.android.ui.RailFlowColors
import com.railflow.android.ui.SectionTitle
import com.railflow.android.ui.Tag
import com.railflow.android.ui.TagRow
import com.railflow.observer.NotReadableReason
import com.railflow.observer.ObservationResult
import com.railflow.observer.ObserverState
import com.railflow.observer.StopReason
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 자동예약 화면.
 *
 * 웹에는 감시 패널이 두 개 있었다(watch-jobs, autobook-panel). 앱에서는
 * **이 한 화면으로 합친다**(android/DESIGN-TOKENS.md).
 */
@Composable
fun AutobookScreen(viewModel: MainViewModel, appState: AppState, observerState: ObserverState) {
    // 읽기에 성공하면 후보의 좌석 확인 상태에 반영한다.
    LaunchedEffect(observerState.lastResult) {
        observerState.lastResult?.let { viewModel.applyObservation(it) }
    }

    SelectedConditionCard(appState)
    TargetPackageCard(viewModel, appState)
    PermissionCard(observerState)
    SessionCard(viewModel, appState, observerState)
    ResultCard(observerState)
    NotImplementedCard()
}

internal fun formatTime(millis: Long?): String {
    if (millis == null) return "없음"
    return SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.KOREA).format(Date(millis))
}

@Composable
private fun SelectedConditionCard(appState: AppState) {
    val condition = appState.condition
    RailCard {
        SectionTitle("선택한 조건")
        Hint("${condition.departure} → ${condition.arrival}")
        Hint("${condition.date.ifBlank { "날짜 미입력" }} · 인원 ${condition.passengers}명 · ${condition.seatClass.label}")
        val range = listOf(condition.timeFrom, condition.timeTo).filter { it.isNotBlank() }
        Hint(if (range.isEmpty()) "희망 시간 제한 없음" else "희망 시간 ${range.joinToString(" ~ ")}")

        SectionTitle("선택한 후보 ${appState.selectedCandidates.size}건")
        if (appState.selectedCandidates.isEmpty()) {
            Hint("예매 화면에서 후보를 선택하세요.")
        }
        for (candidate in appState.selectedCandidates) {
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                Text(
                    text = "${candidate.trainLabel} · ${candidate.departAt.ifBlank { "시각 미입력" }}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = RailFlowColors.Foreground,
                )
                TagRow {
                    Tag(
                        text = candidate.source.label,
                        container = if (candidate.source.verifiedReal) RailFlowColors.Accent else RailFlowColors.Muted,
                        contentColor = if (candidate.source.verifiedReal) {
                            RailFlowColors.AccentForeground
                        } else {
                            RailFlowColors.MutedForeground
                        },
                    )
                    Tag(candidate.seatCheck.label)
                    if (candidate.seatCheckedAtMillis != null) {
                        Tag("확인 ${formatTime(candidate.seatCheckedAtMillis)}")
                    }
                }
            }
        }
    }
}

@Composable
private fun TargetPackageCard(viewModel: MainViewModel, appState: AppState) {
    var input by rememberSaveable { mutableStateOf("") }
    RailCard {
        SectionTitle("대상 앱 패키지")
        Hint("앱 이름으로 패키지를 추측하지 않습니다. 확인한 패키지명을 직접 넣어 주세요. 비어 있으면 어떤 화면도 읽지 않습니다.")
        if (appState.targetPackages.isEmpty()) {
            Hint("설정된 대상 앱이 없습니다.")
        }
        for (packageName in appState.targetPackages) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = packageName,
                    style = MaterialTheme.typography.bodyMedium,
                    color = RailFlowColors.Foreground,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.removeTargetPackage(packageName) }) {
                    Text("삭제", color = RailFlowColors.Destructive, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        OutlinedTextField(
            value = input,
            onValueChange = { input = it },
            label = { Text("패키지명", style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = RailFlowColors.Primary,
                unfocusedBorderColor = RailFlowColors.InputBorder,
                focusedTextColor = RailFlowColors.Foreground,
                unfocusedTextColor = RailFlowColors.Foreground,
                cursorColor = RailFlowColors.Primary,
            ),
        )
        OutlinedButton(
            onClick = {
                viewModel.addTargetPackage(input)
                input = ""
            },
            enabled = input.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("대상 앱 추가")
        }
    }
}

@Composable
private fun PermissionCard(observerState: ObserverState) {
    val context = LocalContext.current
    RailCard {
        SectionTitle("접근성 권한")
        Hint(
            if (observerState.serviceConnected) {
                "접근성 서비스가 연결돼 있습니다. 권한이 켜진 것이며, 좌석을 조회했다는 뜻은 아닙니다."
            } else {
                "접근성 서비스가 꺼져 있습니다. 설정에서 RailFlow를 켜 주세요."
            },
        )
        Hint("켜기 전에 읽는 정보와 보관 여부를 확인하세요: 열차번호·출발시각·좌석 표시 문구만 읽고, 화면 원문·스크린샷을 저장하지 않으며 외부로 보내지 않습니다.")
        OutlinedButton(
            onClick = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("접근성 설정 열기")
        }
    }
}

@Composable
private fun SessionCard(viewModel: MainViewModel, appState: AppState, observerState: ObserverState) {
    val canStart = observerState.serviceConnected &&
        appState.targetPackages.isNotEmpty() &&
        appState.selectedCandidates.isNotEmpty()

    RailCard {
        SectionTitle("읽기 전용 확인")
        Hint("사용자가 시작한 세션에서만 읽습니다. 반복 조회를 하지 않으므로, 공식 앱에서 직접 검색 결과를 띄우면 그 화면을 한 번 읽습니다.")

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = { viewModel.startObservation() },
                enabled = canStart && !observerState.sessionActive,
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.medium,
                colors = ButtonDefaults.buttonColors(
                    containerColor = RailFlowColors.Primary,
                    contentColor = RailFlowColors.PrimaryForeground,
                    disabledContainerColor = RailFlowColors.Muted,
                    disabledContentColor = RailFlowColors.MutedForeground,
                ),
            ) {
                Text("확인 시작")
            }
            Button(
                onClick = { viewModel.stopObservation() },
                enabled = observerState.sessionActive,
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.medium,
                colors = ButtonDefaults.buttonColors(
                    containerColor = RailFlowColors.Destructive,
                    contentColor = RailFlowColors.PrimaryForeground,
                    disabledContainerColor = RailFlowColors.Muted,
                    disabledContentColor = RailFlowColors.MutedForeground,
                ),
            ) {
                Text("즉시 중단")
            }
        }

        if (!canStart && !observerState.sessionActive) {
            if (!observerState.serviceConnected) Hint("· 접근성 서비스가 꺼져 있습니다.")
            if (appState.targetPackages.isEmpty()) Hint("· 대상 앱 패키지가 설정되지 않았습니다.")
            if (appState.selectedCandidates.isEmpty()) Hint("· 선택한 후보가 없습니다.")
        }

        TagRow {
            Tag(
                text = if (observerState.sessionActive) "관찰 중" else "중단됨",
                container = if (observerState.sessionActive) RailFlowColors.Accent else RailFlowColors.Muted,
                contentColor = if (observerState.sessionActive) {
                    RailFlowColors.AccentForeground
                } else {
                    RailFlowColors.MutedForeground
                },
            )
            Tag("시도 ${observerState.attempts}회")
            Tag("읽기 성공 ${observerState.reads}회")
            observerState.stoppedReason?.let { Tag(stopLabel(it)) }
        }

        OutlinedButton(
            onClick = { viewModel.openDiagnostics(true) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("자체 진단 화면 열기")
        }
        Hint("공식 앱에 쓰기 전에, 앱이 만든 시험 화면으로 읽기 동작을 먼저 확인하세요.")
    }
}

private fun stopLabel(reason: StopReason): String = when (reason) {
    StopReason.USER_STOPPED -> "사용자 중단"
    StopReason.SERVICE_DISCONNECTED -> "권한 해제·서비스 종료"
    StopReason.ACCESS_RESTRICTED -> "접근 제한 관찰"
    StopReason.NOT_STARTED -> "시작 전"
}

@Composable
private fun ResultCard(observerState: ObserverState) {
    RailCard {
        SectionTitle("관찰 결과")
        val result: ObservationResult? = observerState.lastResult
        if (result == null) {
            Hint("아직 읽은 화면이 없습니다.")
            return@RailCard
        }
        Hint("확인 시각 ${formatTime(result.observedAtMillis)}")
        Hint("출처 앱 ${result.sourcePackage ?: "불명"}")

        if (!result.readable) {
            Tag(
                text = "읽기 불가",
                container = RailFlowColors.Muted,
                contentColor = RailFlowColors.Destructive,
            )
            Hint(notReadableLabel(result.reason))
            return@RailCard
        }

        Tag("읽기 성공", RailFlowColors.Accent, RailFlowColors.AccentForeground)
        for (train in result.trains) {
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(
                    text = train.trainLabel,
                    style = MaterialTheme.typography.bodyLarge,
                    color = RailFlowColors.Foreground,
                )
                Hint(
                    "출발 ${train.departAt ?: "불명"} · 도착 ${train.arriveAt ?: "불명"}",
                )
                TagRow {
                    Tag("일반실 ${MainViewModel.label(train.generalSeat)}")
                    Tag("특실 ${MainViewModel.label(train.specialSeat)}")
                }
                if (train.seatLabels.isNotEmpty()) {
                    Hint("읽은 문구: ${train.seatLabels.joinToString(" / ")}")
                }
            }
        }
    }
}

internal fun notReadableLabel(reason: NotReadableReason?): String = when (reason) {
    NotReadableReason.SESSION_NOT_ACTIVE -> "관찰 세션이 시작되지 않았습니다."
    NotReadableReason.TARGET_PACKAGE_NOT_CONFIGURED -> "대상 앱 패키지가 설정되지 않았습니다."
    NotReadableReason.NOT_TARGET_PACKAGE -> "대상 앱이 아닌 화면입니다. 처리하지 않았습니다."
    NotReadableReason.EXCLUDED_SCREEN -> "로그인·결제·개인정보 화면으로 판단해 처리하지 않았습니다."
    NotReadableReason.NO_TRAIN_INFO_IN_NODES ->
        "접근성 정보에 열차 정보가 없어 읽지 못했습니다. 화면 캡처나 다른 방식으로 바꾸지 않습니다."
    null -> "사유 없음"
}

@Composable
private fun NotImplementedCard() {
    RailCard {
        SectionTitle("이 버전에서 실행하지 않는 기능")
        DisabledFeature(
            title = "잔여좌석 반복 조회",
            reason = "공식·승인된 조회 수단이 확인되지 않았습니다. 반복 조회는 구현하지 않았습니다.",
        )
        DisabledFeature(
            title = "실제 예약 확보",
            reason = "공식·승인된 예약 연동이 없습니다. 이 앱은 예약을 생성하지 않습니다.",
        )
        DisabledFeature(
            title = "결제",
            reason = "결제는 자동화하지 않습니다. 사용자가 공식 앱에서 직접 결제합니다.",
        )
    }
}
