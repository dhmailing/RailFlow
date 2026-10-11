package com.railflow.android

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.railflow.android.ui.Hint
import com.railflow.android.ui.RailCard
import com.railflow.android.ui.RailFlowColors
import com.railflow.android.ui.SectionTitle
import com.railflow.android.ui.Tag
import com.railflow.android.ui.TagRow
import com.railflow.observer.ObserverState
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    viewModel: MainViewModel,
    appState: AppState,
    observerState: ObserverState,
    onRequestNotificationPermission: () -> Unit,
) {
    PermissionStatusCard(observerState, onRequestNotificationPermission)
    NotificationTestCard()
    LocalDataCard(viewModel, appState)
    AboutCard()
}

@Composable
private fun PermissionStatusCard(
    observerState: ObserverState,
    onRequestNotificationPermission: () -> Unit,
) {
    val context = LocalContext.current
    val notificationsOn = Notifications.hasPermission(context)

    RailCard {
        SectionTitle("권한 상태")
        TagRow {
            Tag(
                text = if (observerState.serviceConnected) "접근성 켜짐" else "접근성 꺼짐",
                container = if (observerState.serviceConnected) RailFlowColors.Accent else RailFlowColors.Muted,
                contentColor = if (observerState.serviceConnected) {
                    RailFlowColors.AccentForeground
                } else {
                    RailFlowColors.MutedForeground
                },
            )
            Tag(
                text = if (notificationsOn) "알림 켜짐" else "알림 꺼짐",
                container = if (notificationsOn) RailFlowColors.Accent else RailFlowColors.Muted,
                contentColor = if (notificationsOn) {
                    RailFlowColors.AccentForeground
                } else {
                    RailFlowColors.MutedForeground
                },
            )
        }
        Hint("권한이 켜졌다는 것은 읽을 수 있는 상태라는 뜻이며, 좌석을 조회했다는 뜻이 아닙니다.")
        Hint("이 앱이 요청하는 권한은 접근성(읽기 전용)과 알림 둘뿐입니다. 화면 캡처, 다른 앱 위에 표시, 알림 읽기, 파일 접근, 연락처, 위치, 카메라, 마이크는 요청하지 않습니다.")

        OutlinedButton(
            onClick = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("접근성 설정 열기")
        }
        OutlinedButton(
            onClick = onRequestNotificationPermission,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("알림 권한 요청")
        }
        OutlinedButton(
            onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", context.packageName, null)
                }
                context.startActivity(intent)
            },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("앱 설정 열기")
        }
    }
}

@Composable
private fun NotificationTestCard() {
    val context = LocalContext.current
    RailCard {
        SectionTitle("알림 테스트")
        Hint("알림이 도착하는지 확인합니다. 실제 좌석 조회와 무관합니다.")
        OutlinedButton(
            onClick = { Notifications.test(context) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("테스트 알림 보내기")
        }
        if (!Notifications.hasPermission(context)) {
            Hint("알림 권한이 꺼져 있어 도착하지 않습니다.")
        }
    }
}

@Composable
private fun LocalDataCard(viewModel: MainViewModel, appState: AppState) {
    var confirming by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    RailCard {
        SectionTitle("로컬 데이터")
        Hint("조건 ${if (appState.condition.isComplete()) "1건" else "미완성"} · 후보 ${appState.candidates.size}건 · 대상 앱 ${appState.targetPackages.size}건")
        Hint("이 앱은 기기 안에만 저장합니다. 철도 계정 비밀번호·OTP·쿠키는 저장하지 않습니다.")
        Button(
            onClick = { confirming = true },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            colors = ButtonDefaults.buttonColors(
                containerColor = RailFlowColors.Destructive,
                contentColor = RailFlowColors.PrimaryForeground,
            ),
        ) {
            Text("로컬 데이터 삭제")
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            containerColor = RailFlowColors.Popover,
            title = { Text("로컬 데이터를 삭제할까요?", color = RailFlowColors.Foreground) },
            text = {
                Text(
                    "조건, 후보 열차, 대상 앱 설정이 모두 지워집니다. 되돌릴 수 없습니다.",
                    color = RailFlowColors.MutedForeground,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { viewModel.clearLocalData() }
                    confirming = false
                }) {
                    Text("삭제", color = RailFlowColors.Destructive)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text("취소", color = RailFlowColors.MutedForeground)
                }
            },
        )
    }
}

@Composable
private fun AboutCard() {
    RailCard {
        SectionTitle("앱 버전과 검증 상태")
        Hint("버전 ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        Hint("설치용 디버그 빌드입니다. 배포 서명이 되어 있지 않습니다.")
        SectionTitle("검증 상태")
        Hint("· 단위 테스트: 실행 — 조건 저장·복원, 출처·좌석등급 유지, 민감 화면 제외, 열차 혼합 방지")
        Hint("· 자체 진단 화면 읽기: 앱에서 직접 확인하세요")
        Hint("· 공식 철도 앱 화면 읽기: NOT RUN — 개발 환경에서 수행하지 않았습니다")
        Hint("· 실제 좌석 조회·예약·결제: 구현하지 않았습니다")
    }
}
