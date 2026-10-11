package com.railflow.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * 공통 카드. 좁은 화면에서 글자가 카드 밖으로 나가지 않도록 내부 여백과
 * fillMaxWidth 를 항상 함께 쓴다.
 */
@Composable
fun RailCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = RailFlowColors.Card),
        border = BorderStroke(1.dp, RailFlowColors.Border),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            content()
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        color = RailFlowColors.Foreground,
        modifier = modifier,
    )
}

@Composable
fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = RailFlowColors.MutedForeground,
        modifier = modifier.fillMaxWidth(),
    )
}

/** 작은 라벨. 글자가 길면 [TagRow] 안에서 줄바꿈된다. */
@Composable
fun Tag(
    text: String,
    container: Color = RailFlowColors.Muted,
    contentColor: Color = RailFlowColors.MutedForeground,
) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = container,
        contentColor = contentColor,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

/** 라벨이 많아도 카드 밖으로 넘치지 않게 줄바꿈한다. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagRow(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    FlowRow(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        content()
    }
}

/** 아직 만들지 않은 기능의 자리. 왜 못 쓰는지 반드시 적는다. */
@Composable
fun DisabledFeature(title: String, reason: String) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = RailFlowColors.Muted,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelLarge,
                color = RailFlowColors.MutedForeground,
            )
            Text(
                text = reason,
                style = MaterialTheme.typography.bodySmall,
                color = RailFlowColors.MutedForeground,
            )
        }
    }
}
