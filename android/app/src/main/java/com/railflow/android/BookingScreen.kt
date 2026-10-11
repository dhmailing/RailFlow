package com.railflow.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.railflow.android.ui.Hint
import com.railflow.android.ui.RailCard
import com.railflow.android.ui.RailFlowColors
import com.railflow.android.ui.SectionTitle
import com.railflow.android.ui.Tag
import com.railflow.android.ui.TagRow

@Composable
fun BookingScreen(viewModel: MainViewModel, appState: AppState) {
    ConditionCard(viewModel, appState)
    CandidateSourceCard(viewModel)
    ManualInputCard(viewModel)
    CandidateListCard(viewModel, appState)
    HandoffCard(viewModel, appState)
}

@Composable
private fun RailTextField(
    value: String,
    label: String,
    modifier: Modifier = Modifier,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label, style = MaterialTheme.typography.bodySmall) },
        singleLine = true,
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = RailFlowColors.Primary,
            unfocusedBorderColor = RailFlowColors.InputBorder,
            focusedTextColor = RailFlowColors.Foreground,
            unfocusedTextColor = RailFlowColors.Foreground,
            focusedLabelColor = RailFlowColors.Primary,
            unfocusedLabelColor = RailFlowColors.MutedForeground,
            cursorColor = RailFlowColors.Primary,
        ),
    )
}

@Composable
private fun ConditionCard(viewModel: MainViewModel, appState: AppState) {
    val condition = appState.condition
    RailCard {
        SectionTitle("예약 조건")
        // 좁은 화면에서는 한 줄에 두 칸을 넣지 않고 세로로 쌓는다.
        RailTextField(condition.departure, "출발역") { value ->
            viewModel.updateCondition { it.copy(departure = value) }
        }
        RailTextField(condition.arrival, "도착역") { value ->
            viewModel.updateCondition { it.copy(arrival = value) }
        }
        RailTextField(condition.date, "운행 날짜 (예: 2026-10-10)") { value ->
            viewModel.updateCondition { it.copy(date = value) }
        }
        RailTextField(condition.timeFrom, "희망 시간 시작 (예: 08:00, 비워도 됩니다)") { value ->
            viewModel.updateCondition { it.copy(timeFrom = value) }
        }
        RailTextField(condition.timeTo, "희망 시간 끝 (예: 12:00, 비워도 됩니다)") { value ->
            viewModel.updateCondition { it.copy(timeTo = value) }
        }
        RailTextField(condition.passengers.toString(), "인원") { value ->
            val parsed = value.filter { it.isDigit() }.toIntOrNull() ?: 1
            viewModel.updateCondition { it.copy(passengers = parsed.coerceIn(1, 9)) }
        }

        SectionTitle("좌석등급")
        TagRow {
            for (choice in SeatClassChoice.entries) {
                FilterChip(
                    selected = condition.seatClass == choice,
                    onClick = { viewModel.updateCondition { it.copy(seatClass = choice) } },
                    label = { Text(choice.label, style = MaterialTheme.typography.labelSmall) },
                    shape = MaterialTheme.shapes.small,
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = RailFlowColors.Accent,
                        selectedLabelColor = RailFlowColors.AccentForeground,
                        containerColor = RailFlowColors.Muted,
                        labelColor = RailFlowColors.MutedForeground,
                    ),
                )
            }
        }
        if (!condition.isComplete()) {
            Hint("출발역·도착역·날짜를 채우면 후보를 선택할 수 있습니다.")
        }
    }
}

@Composable
private fun CandidateSourceCard(viewModel: MainViewModel) {
    RailCard {
        SectionTitle("후보 출처")
        Hint("출처마다 믿을 수 있는 정도가 다릅니다. 앱은 이 구분을 지우지 않고 그대로 표시합니다.")
        for (source in CandidateSource.entries) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Tag(
                        text = source.label,
                        container = if (source.verifiedReal) RailFlowColors.Accent else RailFlowColors.Muted,
                        contentColor = if (source.verifiedReal) {
                            RailFlowColors.AccentForeground
                        } else {
                            RailFlowColors.MutedForeground
                        },
                    )
                    if (source.verifiedReal) Tag("실제 확인", RailFlowColors.Accent, RailFlowColors.AccentForeground)
                }
                Hint(source.note)
            }
        }
        Button(
            onClick = { viewModel.loadDemoCandidates() },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            colors = ButtonDefaults.buttonColors(
                containerColor = RailFlowColors.Primary,
                contentColor = RailFlowColors.PrimaryForeground,
            ),
        ) {
            Text("가상 데이터 후보 불러오기")
        }
        Hint("실제 시간표 조회는 이 버전에 연결되지 않았습니다. 가상 데이터는 실제 운행과 무관합니다.")
    }
}

@Composable
private fun ManualInputCard(viewModel: MainViewModel) {
    var trainLabel by rememberSaveable { mutableStateOf("") }
    var departAt by rememberSaveable { mutableStateOf("") }
    var arriveAt by rememberSaveable { mutableStateOf("") }

    RailCard {
        SectionTitle("열차 직접 입력")
        Hint("직접 입력한 열차는 실제 운행 여부를 확인하지 않습니다. 화면에 항상 '직접 입력'으로 표시됩니다.")
        RailTextField(trainLabel, "열차 (예: KTX 101)") { trainLabel = it }
        RailTextField(departAt, "출발 시각 (예: 08:05)") { departAt = it }
        RailTextField(arriveAt, "도착 시각 (예: 10:35)") { arriveAt = it }
        OutlinedButton(
            onClick = {
                viewModel.addManualCandidate(trainLabel, departAt, arriveAt)
                trainLabel = ""
                departAt = ""
                arriveAt = ""
            },
            enabled = trainLabel.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("후보에 추가")
        }
    }
}

@Composable
private fun CandidateListCard(viewModel: MainViewModel, appState: AppState) {
    RailCard {
        SectionTitle("후보 열차 ${appState.candidates.size}건")
        if (appState.candidates.isEmpty()) {
            Hint("아직 후보가 없습니다. 가상 데이터를 불러오거나 직접 입력하세요.")
            return@RailCard
        }
        for (candidate in appState.candidates) {
            CandidateRow(candidate, viewModel)
        }
    }
}

@Composable
private fun CandidateRow(candidate: CandidateTrain, viewModel: MainViewModel) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(
                checked = candidate.selected,
                onCheckedChange = { viewModel.toggleCandidate(candidate.id) },
                colors = CheckboxDefaults.colors(
                    checkedColor = RailFlowColors.Primary,
                    checkmarkColor = RailFlowColors.PrimaryForeground,
                    uncheckedColor = RailFlowColors.InputBorder,
                ),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = candidate.trainLabel,
                    style = MaterialTheme.typography.bodyLarge,
                    color = RailFlowColors.Foreground,
                )
                Text(
                    text = listOf(candidate.departAt, candidate.arriveAt)
                        .filter { it.isNotBlank() }
                        .joinToString(" → ")
                        .ifBlank { "시각 미입력" },
                    style = MaterialTheme.typography.bodySmall,
                    color = RailFlowColors.MutedForeground,
                )
            }
            TextButton(onClick = { viewModel.removeCandidate(candidate.id) }) {
                Text("삭제", color = RailFlowColors.Destructive, style = MaterialTheme.typography.labelSmall)
            }
        }
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
        }
    }
}

@Composable
private fun HandoffCard(viewModel: MainViewModel, appState: AppState) {
    RailCard {
        SectionTitle("자동예약으로 전달")
        Hint("선택한 후보 ${appState.selectedCandidates.size}건과 위 조건을 자동예약 화면으로 보냅니다.")
        Button(
            onClick = { viewModel.selectTab(Tab.AUTOBOOK) },
            enabled = appState.selectedCandidates.isNotEmpty() && appState.condition.isComplete(),
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            colors = ButtonDefaults.buttonColors(
                containerColor = RailFlowColors.Primary,
                contentColor = RailFlowColors.PrimaryForeground,
                disabledContainerColor = RailFlowColors.Muted,
                disabledContentColor = RailFlowColors.MutedForeground,
            ),
        ) {
            Text("자동예약 조건 화면으로")
        }
        if (appState.selectedCandidates.isEmpty()) {
            Hint("후보를 하나 이상 선택하세요.")
        }
    }
}
