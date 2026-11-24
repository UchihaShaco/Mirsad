package app.mirsad.shield.service

import android.app.Notification
import android.provider.Telephony
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.Level
import app.mirsad.shield.MirsadApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Watches message notifications from the monitored apps and runs them through the pipeline.
 * HOLD removes the original notification (a copy stays in Quarantine); WARN leaves it and adds a caution.
 * Reads only what the notification shows; no contacts, no SMS provider.
 */
class MirsadNotificationListener : NotificationListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** LRU of notification key + text hash so re-posted notifications are analysed once. */
    private val seen = object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean = size > DEDUPE_SIZE
    }

    override fun onListenerConnected() {
        Log.i(TAG, "notification listener connected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        if (sbn.packageName == packageName) return
        val notification = sbn.notification ?: return
        if (notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val content = extract(notification)
        val pkg = sbn.packageName
        val key = sbn.key
        val postTime = sbn.postTime
        scope.launch {
            try {
                handle(pkg, key, postTime, content)
            } catch (t: Throwable) {
                Log.e(TAG, "failed to handle notification from $pkg", t)
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun handle(pkg: String, key: String, postTime: Long, content: Content) {
        val container = MirsadApp.container(this)
        if (pkg !in container.settings.get().monitoredPackages) return
        val dedupeKey = key + "|" + content.text.orEmpty().hashCode()
        val duplicate = synchronized(seen) { seen.put(dedupeKey, true) != null }
        if (duplicate) return

        val sender = content.sender?.trim().orEmpty()
        val channel = if (isSmsApp(pkg)) Channel.SMS else Channel.CHAT
        val isNumber = Senders.looksLikePhoneNumber(sender)
        // A name is treated as a saved contact; a short all-caps SMS sender ID (e.g. "ADCB") is not.
        val looksLikeContact = !isNumber && sender.isNotBlank() &&
            !(channel == Channel.SMS && Senders.looksLikeAlphanumericId(sender))
        val hidden = content.text.isNullOrBlank()
        val event = Event(
            channel = channel,
            sender = sender,
            text = if (hidden) null else content.text,
            appPackage = pkg,
            timestamp = postTime,
            senderLooksLikeContact = looksLikeContact,
            contentHidden = hidden,
        )
        val incident = container.pipeline.process(event, IncidentSource.NOTIFICATION, synthetic = false)
        if (incident.level == Level.HOLD) {
            runCatching { cancelNotification(key) }
                .onSuccess { Log.i(TAG, "removed notification $key for incident #${incident.id}") }
                .onFailure { Log.w(TAG, "could not remove notification $key", it) }
            container.incidents.update(incident.copy(notificationRemoved = true, notificationKey = key))
        }
    }

    private fun isSmsApp(pkg: String): Boolean =
        pkg in SMS_PACKAGES || pkg == runCatching { Telephony.Sms.getDefaultSmsPackage(this) }.getOrNull()

    private class Content(val sender: String?, val text: String?)

    /** Title/text/bigText plus the last MessagingStyle message (its text and sender). */
    private fun extract(notification: Notification): Content {
        val extras = notification.extras
        val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        val bigText = extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        var messageText: String? = null
        var messageSender: String? = null
        runCatching { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification) }
            .getOrNull()?.messages?.lastOrNull()?.let { message ->
                messageText = message.text?.toString()
                messageSender = message.person?.name?.toString()
            }
        val body = listOf(messageText, bigText, text).firstOrNull { !it.isNullOrBlank() }
        val sender = listOf(messageSender, title).firstOrNull { !it.isNullOrBlank() }
        return Content(sender, body)
    }

    private companion object {
        const val TAG = "MirsadListener"
        const val DEDUPE_SIZE = 200
        val SMS_PACKAGES = setOf(DefaultPackages.GOOGLE_MESSAGES, DefaultPackages.AOSP_MESSAGING, DefaultPackages.SAMSUNG_MESSAGES)
    }
}
