package com.railflow.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.railflow.android.ui.Hint
import com.railflow.android.ui.RailCard
import com.railflow.android.ui.RailFlowColors
import com.railflow.android.ui.SectionTitle
import com.railflow.android.ui.Tag
import com.railflow.android.ui.TagRow
import com.railflow.observer.ObserverState

/**
 * 자체 진단 화면.
 *
 * 공식 앱에 쓰기 전에 **앱이 만든 시험 화면**으로 읽기 동작을 확인한다.
 * 여기 보이는 열차는 전부 가상이며, 이 화면에서 읽기가 성공해도 그것은
 * **실제 좌석 조회가 아니다.**
 */
@Composable
fun DiagnosticsScreen(viewModel: MainViewModel, observerState: ObserverState) {
    RailCard {
        SectionTitle("자체 진단")
        Hint("아래 시험 화면은 앱이 직접 그린 가상 열차 목록입니다. 접근성 서비스가 이 화면을 읽을 수 있는지 확인합니다.")
        Hint("여기서 읽기가 성공해도 실제 좌석을 조회한 것이 아닙니다.")
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = { viewModel.startSelfDiagnostics() },
                enabled = observerState.serviceConnected && !observerState.sessionActive,
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.medium,
                colors = ButtonDefaults.buttonColors(
                    containerColor = RailFlowColors.Primary,
                    contentColor = RailFlowColors.PrimaryForeground,
                    disabledContainerColor = RailFlowColors.Muted,
                    disabledContentColor = RailFlowColors.MutedForeground,
                ),
            ) {
                Text("진단 시작")
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
                Text("중단")
            }
        }
        if (!observerState.serviceConnected) {
            Hint("접근성 서비스가 꺼져 있어 진단을 시작할 수 없습니다.")
        }
        OutlinedButton(
            onClick = { viewModel.openDiagnostics(false) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("자동예약 화면으로 돌아가기")
        }
    }

    FixtureCard()

    RailCard {
        SectionTitle("진단 결과")
        TagRow {
            Tag(if (observerState.sessionActive) "진단 중" else "중단됨")
            Tag("시도 ${observerState.attempts}회")
            Tag("읽기 성공 ${observerState.reads}회")
        }
        val result = observerState.lastResult
        if (result == null) {
            Hint("아직 읽은 화면이 없습니다. 진단을 시작하고 이 화면을 잠시 스크롤해 보세요.")
            return@RailCard
        }
        Hint("확인 시각 ${formatTime(result.observedAtMillis)}")
        if (!result.readable) {
            Hint("읽기 불가: ${notReadableLabel(result.reason)}")
            return@RailCard
        }
        Hint("읽은 열차 ${result.trains.size}건")
        for (train in result.trains) {
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                Text(
                    text = "${train.trainLabel} · 출발 ${train.departAt ?: "불명"}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = RailFlowColors.Foreground,
                )
                TagRow {
                    Tag("일반실 ${MainViewModel.label(train.generalSeat)}")
                    Tag("특실 ${MainViewModel.label(train.specialSeat)}")
                }
            }
        }
    }
}

/**
 * 시험용 검색 결과.
 *
 * 열차 한 편이 한 Column 안에 들어 있어, 파서가 행 경계를 트리에서 찾을 수
 * 있다. 실제 공식 앱 화면 구조와 같다고 가정하지 않는다 -- 읽기 경로가
 * 동작하는지만 본다.
 */
@Composable
private fun FixtureCard() {
    RailCard {
        SectionTitle("시험 화면 (가상 데이터)")
        FixtureRow("KTX 101", "08:05", "10:35", "일반실 매진", "특실 예약가능")
        FixtureRow("SRT 357", "09:10", "11:40", "일반실 3석", "특실 매진")
        FixtureRow("무궁화 1234", "11:20", "15:05", null, null)
    }
}

@Composable
private fun FixtureRow(
    trainLabel: String,
    departAt: String,
    arriveAt: String,
    generalSeat: String?,
    specialSeat: String?,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(trainLabel, style = MaterialTheme.typography.bodyLarge, color = RailFlowColors.Foreground)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(departAt, style = MaterialTheme.typography.bodySmall, color = RailFlowColors.MutedForeground)
            Text(arriveAt, style = MaterialTheme.typography.bodySmall, color = RailFlowColors.MutedForeground)
        }
        if (generalSeat != null) {
            Text(generalSeat, style = MaterialTheme.typography.bodySmall, color = RailFlowColors.MutedForeground)
        }
        if (specialSeat != null) {
            Text(specialSeat, style = MaterialTheme.typography.bodySmall, color = RailFlowColors.MutedForeground)
        }
        if (generalSeat == null && specialSeat == null) {
            Text("좌석 문구 없음", style = MaterialTheme.typography.bodySmall, color = RailFlowColors.MutedForeground)
        }
    }
}
