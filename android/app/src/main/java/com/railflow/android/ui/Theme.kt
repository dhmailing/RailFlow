package com.railflow.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 웹 app/globals.css 에서 가져온 값이다(android/DESIGN-TOKENS.md).
 * 비슷한 색을 새로 만들지 않는다.
 */
object RailFlowColors {
    val Background = Color(0xFF070707)
    val Foreground = Color(0xFFF7F7F7)
    val Card = Color(0xFF111111)
    val Popover = Color(0xFF171717)
    val Primary = Color(0xFFFF8A1F)
    val PrimaryForeground = Color(0xFF090909)
    val Secondary = Color(0xFF1D1D1D)
    val Muted = Color(0xFF1C1C1C)
    val MutedForeground = Color(0xFF929292)
    val Accent = Color(0xFF2A1A0D)
    val AccentForeground = Color(0xFFFFBD7B)
    val Destructive = Color(0xFFFF5F57)
    val Border = Color(0xFF2B2B2B)
    val InputBorder = Color(0xFF333333)
    val NavBar = Color(0xFF0D0D0D)
}

private val RailFlowScheme = darkColorScheme(
    primary = RailFlowColors.Primary,
    onPrimary = RailFlowColors.PrimaryForeground,
    primaryContainer = RailFlowColors.Accent,
    onPrimaryContainer = RailFlowColors.AccentForeground,
    secondary = RailFlowColors.Secondary,
    onSecondary = RailFlowColors.Foreground,
    background = RailFlowColors.Background,
    onBackground = RailFlowColors.Foreground,
    surface = RailFlowColors.Card,
    onSurface = RailFlowColors.Foreground,
    surfaceVariant = RailFlowColors.Muted,
    onSurfaceVariant = RailFlowColors.MutedForeground,
    error = RailFlowColors.Destructive,
    onError = RailFlowColors.PrimaryForeground,
    outline = RailFlowColors.Border,
    outlineVariant = RailFlowColors.InputBorder,
)

/** 웹의 --radius 0.875rem = 14dp 체계. */
private val RailFlowShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(14.dp),
    extraLarge = RoundedCornerShape(20.dp),
)

private val RailFlowTypography = Typography(
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.Medium),
)

/** 웹과 같은 어두운 테마 하나만 쓴다. 시스템 설정으로 색이 바뀌지 않는다. */
@Composable
fun RailFlowTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = RailFlowScheme,
        shapes = RailFlowShapes,
        typography = RailFlowTypography,
        content = content,
    )
}
