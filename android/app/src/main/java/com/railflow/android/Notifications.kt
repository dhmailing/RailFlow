package com.railflow.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * 결과·오류·중단 안내용 알림.
 *
 * 알림 본문에 자격증명·세션·화면 원문을 넣지 않는다. 읽은 열차 표시만
 * 요약해서 쓴다.
 */
object Notifications {

    const val CHANNEL_ID = "railflow_observation"
    private const val ID_RESULT = 1001
    private const val ID_STOPPED = 1002
    private const val ID_TEST = 1003

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "관찰 결과",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "읽기 전용 관찰의 결과·오류·중단을 알립니다."
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(channel)
    }

    /**
     * 알림을 보낼 수 있는가.
     *
     * API 33 이상에서는 런타임 권한을 직접 확인한다. areNotificationsEnabled()
     * 만으로는 lint 가 권한 검사로 알아보지 못하고, 사용자가 채널을 끈 경우도
     * 함께 걸러야 한다.
     */
    fun hasPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun notify(context: Context, id: Int, title: String, body: String) {
        if (!hasPermission(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (error: SecurityException) {
            // 권한이 방금 해제된 경우. 알림을 못 보낸 것으로 두고 앱은 계속 쓴다.
        }
    }

    fun observationRead(context: Context, summary: String) =
        notify(context, ID_RESULT, "좌석 표시를 읽었습니다", summary)

    fun observationStopped(context: Context, reason: String) =
        notify(context, ID_STOPPED, "관찰을 중단했습니다", reason)

    fun test(context: Context) =
        notify(context, ID_TEST, "RailFlow 알림 테스트", "알림이 정상적으로 도착했습니다. 실제 좌석을 조회한 것은 아닙니다.")
}
