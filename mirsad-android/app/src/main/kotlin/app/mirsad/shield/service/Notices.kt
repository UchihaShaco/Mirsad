package app.mirsad.shield.service

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Telephony
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.SenderType
import app.mirsad.core.contract.UndoToken
import app.mirsad.shield.MainActivity
import app.mirsad.shield.R
import kotlinx.serialization.json.Json

/**
 * Mirsad's own notifications: quiet HOLD notices, heads-up WARN cautions and "restored" copies.
 * Every notice carries the safety line. Demo (synthetic) incidents get a "Demo" prefix.
 */
object Notices {
    /** Quiet by design: a held item is already safe, so its notice makes no sound. */
    const val CHANNEL_HOLDS = "mirsad_holds_quiet"
    const val CHANNEL_WARNINGS = "mirsad_warnings"
    const val CHANNEL_RESTORED = "mirsad_restored"

    private const val TAG = "MirsadNotices"
    private const val TAG_INCIDENT = "incident"
    private const val TAG_RESTORED = "restored"
    private const val GROUP_HOLD = "app.mirsad.shield.group.HOLD"
    private const val GROUP_WARN = "app.mirsad.shield.group.WARN"
    private const val SLOT_OPEN = 0
    private const val SLOT_REPORT = 1
    private const val SLOT_NOT_SCAM = 2
    private const val SLOT_SOURCE = 3
    private const val SLOT_UNDO = 4
    private const val CALL_WARN_TIMEOUT_MS = 90_000L

    /** MainActivity.EXTRA_SCREEN value that opens the report preview. */
    private const val SCREEN_REPORT = "report"

    fun createChannels(context: Context) {
        val channels = listOf(
            NotificationChannelCompat.Builder(CHANNEL_HOLDS, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(context.getString(R.string.channel_holds_name))
                .setDescription(context.getString(R.string.channel_holds_description))
                .build(),
            NotificationChannelCompat.Builder(CHANNEL_WARNINGS, NotificationManagerCompat.IMPORTANCE_HIGH)
                .setName(context.getString(R.string.channel_warnings_name))
                .setDescription(context.getString(R.string.channel_warnings_description))
                .build(),
            NotificationChannelCompat.Builder(CHANNEL_RESTORED, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(context.getString(R.string.channel_restored_name))
                .setDescription(context.getString(R.string.channel_restored_description))
                .build(),
        )
        NotificationManagerCompat.from(context).apply {
            createNotificationChannelsCompat(channels)
            deleteNotificationChannel("mirsad_holds") // the earlier, noisy channel
        }
    }

    /** Posts the HOLD or WARN notice for [incident]; does nothing for ALLOW. */
    fun postIncident(context: Context, incident: Incident) {
        if (incident.level == Level.ALLOW) return
        val hold = incident.level == Level.HOLD
        val isCall = incident.channel == Channel.CALL
        val sender = displaySender(context, incident)
        val reasons = ReasonText.summary(context, incident.reasons)
        val safety = context.getString(R.string.notice_safety_line)

        val title = when {
            isCall && hold -> context.getString(R.string.notice_hold_call_title, sender)
            isCall -> context.getString(R.string.notice_warn_call_title, sender)
            hold -> context.getString(R.string.notice_hold_message_title, sender)
            else -> context.getString(R.string.notice_warn_message_title, sender)
        }.let { withDemoPrefix(context, incident, it) }
        val lines = buildList {
            addAll(reasons)
            if (isCall && hold) add(context.getString(R.string.notice_hold_call_log))
            add(safety)
        }

        val builder = NotificationCompat.Builder(context, if (hold) CHANNEL_HOLDS else CHANNEL_WARNINGS)
            .setSmallIcon(R.drawable.ic_notice)
            .setContentTitle(title)
            .setContentText(reasons.firstOrNull() ?: safety)
            .setStyle(NotificationCompat.BigTextStyle().bigText(lines.joinToString("\n")))
            .setContentIntent(openIncident(context, incident.id))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setWhen(incident.createdAt)
            .setShowWhen(true)
            .setGroup(if (hold) GROUP_HOLD else GROUP_WARN)
            .setCategory(if (isCall) NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (hold) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .addAction(0, context.getString(R.string.notice_action_not_scam), notScamAction(context, incident.id))
            .addAction(0, context.getString(R.string.notice_action_report), openReport(context, incident.id))
        if (isCall && !hold) builder.setTimeoutAfter(CALL_WARN_TIMEOUT_MS)
        notify(context, TAG_INCIDENT, notificationId(incident.id), builder.build())
    }

    /**
     * The "restore" of a wrongly held message: a normal notification with the original title and text whose
     * tap opens the source app. With an [undoToken] it also carries an Undo action.
     */
    fun postRestored(context: Context, incident: Incident, undoToken: UndoToken?) {
        val isCall = incident.channel == Channel.CALL
        val sender = displaySender(context, incident)
        val title = if (isCall) {
            context.getString(R.string.notice_not_scam_call_title, sender)
        } else {
            incident.title?.takeIf { it.isNotBlank() } ?: sender
        }
        val text = if (isCall) context.getString(R.string.notice_not_scam_call_text) else incident.text.orEmpty()
        val builder = NotificationCompat.Builder(context, CHANNEL_RESTORED)
            .setSmallIcon(R.drawable.ic_notice)
            .setContentTitle(withDemoPrefix(context, incident, title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSubText(context.getString(R.string.notice_restored_subtext))
            .setContentIntent(if (isCall) openIncident(context, incident.id) else openSourceApp(context, incident))
            .setAutoCancel(true)
            .setWhen(incident.createdAt)
            .setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        if (undoToken != null) {
            builder.addAction(0, context.getString(R.string.notice_action_undo), undoAction(context, undoToken))
        }
        notify(context, TAG_RESTORED, notificationId(incident.id), builder.build())
    }

    fun cancelIncident(context: Context, incidentId: Long) =
        NotificationManagerCompat.from(context).cancel(TAG_INCIDENT, notificationId(incidentId))

    fun cancelRestored(context: Context, incidentId: Long) =
        NotificationManagerCompat.from(context).cancel(TAG_RESTORED, notificationId(incidentId))

    /** True when a Mirsad notice can actually reach the user (permission granted and notifications not blocked). */
    fun canPost(context: Context): Boolean =
        (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            ) && NotificationManagerCompat.from(context).areNotificationsEnabled()

    // --- helpers --------------------------------------------------------------------------------

    private fun displaySender(context: Context, incident: Incident): String {
        val sender = incident.sender.trim()
        return when {
            // Numbers and IDs are wrapped in a left-to-right isolate so "+971..." reads correctly inside Arabic.
            sender.isNotBlank() -> "\u2066" + sender + "\u2069"
            !incident.title.isNullOrBlank() -> incident.title.orEmpty()
            else -> context.getString(R.string.notice_unknown_sender)
        }
    }

    private fun withDemoPrefix(context: Context, incident: Incident, title: String): String =
        if (incident.synthetic) context.getString(R.string.notice_demo_prefix) + ": " + title else title

    private fun notificationId(incidentId: Long): Int = (incidentId and 0x7fffffffL).toInt()

    private fun requestCode(incidentId: Long, slot: Int): Int = ((incidentId * 8 + slot) and 0x7fffffffL).toInt()

    private fun mainIntent(context: Context, incidentId: Long?, screen: String?): Intent =
        Intent(context, MainActivity::class.java).apply {
            // CLEAR_TASK recreates MainActivity so the extras are read in onCreate even when the app is open.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            if (incidentId != null && incidentId > 0) putExtra(MainActivity.EXTRA_INCIDENT_ID, incidentId)
            if (screen != null) putExtra(MainActivity.EXTRA_SCREEN, screen)
        }

    private fun openIncident(context: Context, incidentId: Long): PendingIntent = PendingIntent.getActivity(
        context, requestCode(incidentId, SLOT_OPEN), mainIntent(context, incidentId, null),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun openReport(context: Context, incidentId: Long): PendingIntent = PendingIntent.getActivity(
        context, requestCode(incidentId, SLOT_REPORT), mainIntent(context, incidentId, SCREEN_REPORT),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notScamAction(context: Context, incidentId: Long): PendingIntent = PendingIntent.getBroadcast(
        context, requestCode(incidentId, SLOT_NOT_SCAM),
        Intent(context, NoticeActionReceiver::class.java)
            .setAction(NoticeActionReceiver.ACTION_NOT_A_SCAM)
            .putExtra(NoticeActionReceiver.EXTRA_INCIDENT_ID, incidentId),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun undoAction(context: Context, token: UndoToken): PendingIntent = PendingIntent.getBroadcast(
        context, requestCode(token.incidentId, SLOT_UNDO),
        Intent(context, NoticeActionReceiver::class.java)
            .setAction(NoticeActionReceiver.ACTION_UNDO)
            .putExtra(NoticeActionReceiver.EXTRA_INCIDENT_ID, token.incidentId)
            .putExtra(NoticeActionReceiver.EXTRA_UNDO_TOKEN, Json.encodeToString(UndoToken.serializer(), token)),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** The source app (or the default SMS app for SMS); falls back to Mirsad's incident screen. */
    private fun openSourceApp(context: Context, incident: Incident): PendingIntent {
        val pm = context.packageManager
        val launch = incident.appPackage?.let { runCatching { pm.getLaunchIntentForPackage(it) }.getOrNull() }
            ?: if (incident.channel == Channel.SMS) {
                runCatching { Telephony.Sms.getDefaultSmsPackage(context) }.getOrNull()
                    ?.let { pm.getLaunchIntentForPackage(it) }
            } else {
                null
            }
        val intent = launch?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: mainIntent(context, incident.id, null)
        return PendingIntent.getActivity(
            context, requestCode(incident.id, SLOT_SOURCE), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    @SuppressLint("MissingPermission") // canPost() checks POST_NOTIFICATIONS on API 33+.
    private fun notify(context: Context, tag: String, id: Int, notification: Notification) {
        if (!canPost(context)) {
            Log.w(TAG, "POST_NOTIFICATIONS not granted; notice $tag/$id skipped")
            return
        }
        try {
            NotificationManagerCompat.from(context).notify(tag, id, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "notice $tag/$id refused", e)
        }
    }
}
