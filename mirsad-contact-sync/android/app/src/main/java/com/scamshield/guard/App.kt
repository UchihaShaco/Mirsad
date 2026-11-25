package com.scamshield.guard

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(GuardService.CHANNEL, "Protection status", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows that Mirsad is keeping your scam-warning contact up to date"
                setShowBadge(false)
            }
        )
    }
}

/** Safety net: every 15 min pull the list over plain HTTPS (in case the socket/service was killed). */
class FallbackWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    companion object {
        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<FallbackWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("fallback-sync", ExistingPeriodicWorkPolicy.UPDATE, req)
        }

        fun cancel(ctx: Context) = WorkManager.getInstance(ctx).cancelUniqueWork("fallback-sync")
    }

    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        if (!prefs.enabled || !prefs.configured) return Result.success()
        GuardService.start(applicationContext)  // revive the live connection if it was killed
        return try {
            val snap = SyncApi.fetch(prefs)
            SyncApi.worker.submit { SyncApi.apply(applicationContext, snap) }.get()
            Result.success()
        } catch (e: Exception) {
            Log.w("FallbackWorker", "sync failed", e)
            Result.retry()
        }
    }
}

/** Bring protection back after reboot / app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = Prefs(ctx)
        if (prefs.enabled && prefs.configured) {
            GuardService.start(ctx)
            FallbackWorker.schedule(ctx)
        }
    }
}
