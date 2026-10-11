package com.railflow.android

import android.app.Application

class RailFlowApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannel(this)
    }
}
