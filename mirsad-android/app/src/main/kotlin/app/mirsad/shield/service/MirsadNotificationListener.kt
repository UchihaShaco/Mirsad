package app.mirsad.shield.service

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Stub. Workstream D implements the listener (see PLAN.md). */
class MirsadNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) = Unit
}
