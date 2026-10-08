package com.railflow.android

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.railflow.android.ui.RailFlowColors
import com.railflow.android.ui.RailFlowTheme

class MainActivity : ComponentActivity() {

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 거부돼도 앱은 쓸 수 있다 */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            RailFlowTheme {
                RailFlowApp(onRequestNotificationPermission = ::requestNotificationPermission)
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RailFlowApp(onRequestNotificationPermission: () -> Unit) {
    val viewModel: MainViewModel = viewModel()
    val appState by viewModel.appState.collectAsState()
    val tab by viewModel.tab.collectAsState()
    val observerState by viewModel.observerState.collectAsState()
    val diagnosticsOpen by viewModel.diagnosticsOpen.collectAsState()

    Scaffold(
        containerColor = RailFlowColors.Background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (diagnosticsOpen) "자체 진단" else "RailFlow",
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = RailFlowColors.NavBar,
                    titleContentColor = RailFlowColors.Foreground,
                ),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = RailFlowColors.NavBar) {
                BottomTab(Tab.BOOKING, tab, R.drawable.ic_tab_ticket, 0) { viewModel.selectTab(it) }
                BottomTab(
                    Tab.AUTOBOOK,
                    tab,
                    R.drawable.ic_tab_refresh,
                    appState.selectedCandidates.size,
                ) { viewModel.selectTab(it) }
                BottomTab(Tab.SETTINGS, tab, R.drawable.ic_tab_person, 0) { viewModel.selectTab(it) }
            }
        },
    ) { innerPadding ->
        Surface(
            modifier = Modifier.fillMaxSize().padding(innerPadding),
            color = RailFlowColors.Background,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                when {
                    diagnosticsOpen -> DiagnosticsScreen(viewModel, observerState)
                    tab == Tab.BOOKING -> BookingScreen(viewModel, appState)
                    tab == Tab.AUTOBOOK -> AutobookScreen(viewModel, appState, observerState)
                    else -> SettingsScreen(
                        viewModel = viewModel,
                        appState = appState,
                        observerState = observerState,
                        onRequestNotificationPermission = onRequestNotificationPermission,
                    )
                }
            }
        }
    }
}

/**
 * 하단 탐색 항목 하나.
 *
 * `NavigationBarItem` 은 Material3 에서 `RowScope` 확장이므로, 이 함수도
 * 같은 수신자를 받아야 `NavigationBar { }` 안에서 쓸 수 있다.
 */
@Composable
private fun RowScope.BottomTab(
    target: Tab,
    current: Tab,
    iconRes: Int,
    badgeCount: Int,
    onSelect: (Tab) -> Unit,
) {
    NavigationBarItem(
        selected = current == target,
        onClick = { onSelect(target) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = RailFlowColors.PrimaryForeground,
            selectedTextColor = RailFlowColors.Primary,
            indicatorColor = RailFlowColors.Primary,
            unselectedIconColor = RailFlowColors.MutedForeground,
            unselectedTextColor = RailFlowColors.MutedForeground,
        ),
        icon = {
            if (badgeCount > 0) {
                BadgedBox(badge = { Badge { Text(badgeCount.toString()) } }) {
                    TabIcon(iconRes, target.label)
                }
            } else {
                TabIcon(iconRes, target.label)
            }
        },
        label = { Text(target.label, style = MaterialTheme.typography.labelSmall) },
    )
}

@Composable
private fun TabIcon(iconRes: Int, description: String) {
    Icon(painter = painterResource(iconRes), contentDescription = description)
}
