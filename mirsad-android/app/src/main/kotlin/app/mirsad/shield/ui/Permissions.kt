package app.mirsad.shield.ui

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/** Live status of the three protections. Read on resume; never cached across screens. */
data class ProtectionStatus(
    val callScreeningAvailable: Boolean,
    val callScreening: Boolean,
    val notificationAccess: Boolean,
    val postNotifications: Boolean,
) {
    val onCount: Int get() = listOf(callScreening, notificationAccess, postNotifications).count { it }

    companion object {
        fun read(context: Context): ProtectionStatus {
            val rm = context.getSystemService(RoleManager::class.java)
            val available = rm?.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) == true
            val held = available && rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
            val listener = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
            val post = NotificationManagerCompat.from(context).areNotificationsEnabled()
            return ProtectionStatus(available, held, listener, post)
        }
    }
}

object PermissionIntents {
    fun requestCallScreening(context: Context): Intent? =
        context.getSystemService(RoleManager::class.java)?.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)

    fun notificationListenerSettings(): Intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)

    fun appNotificationSettings(context: Context): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

    /** Runtime permission exists from API 33; below that notifications are on unless the user blocked them. */
    val needsRuntimePostPermission: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
}
