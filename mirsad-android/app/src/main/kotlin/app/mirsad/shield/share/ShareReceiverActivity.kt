package app.mirsad.shield.share

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.IncidentSource
import app.mirsad.shield.MainActivity
import app.mirsad.shield.MirsadApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * "Check with Mirsad" share target: runs the shared text through the pipeline, then opens the incident.
 * Shows nothing itself (translucent theme).
 */
class ShareReceiverActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent?.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        val subject = intent?.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.trim().orEmpty()
        val shared = listOf(subject, text).filter { it.isNotBlank() }.joinToString("\n")
        if (shared.isBlank()) {
            openMain(null)
            finish()
            return
        }
        val referrerPackage = referrer?.takeIf { it.scheme == "android-app" }?.host
        val event = Event(
            channel = Channel.CHAT,
            sender = SHARED_SENDER,
            text = shared,
            appPackage = referrerPackage,
            timestamp = System.currentTimeMillis(),
            senderLooksLikeContact = false,
        )
        scope.launch {
            val incident = withContext(Dispatchers.Default) {
                runCatching { MirsadApp.container(this@ShareReceiverActivity).pipeline.process(event, IncidentSource.SHARE, synthetic = false) }
                    .onFailure { Log.e(TAG, "share check failed", it) }
                    .getOrNull()
            }
            openMain(incident?.id)
            finish()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun openMain(incidentId: Long?) {
        startActivity(
            Intent(this, MainActivity::class.java).apply {
                // CLEAR_TASK recreates MainActivity so the incident extra is read in onCreate even when the app is open.
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                if (incidentId != null && incidentId > 0) putExtra(MainActivity.EXTRA_INCIDENT_ID, incidentId)
            },
        )
    }

    private companion object {
        const val TAG = "MirsadShare"
        /** The sender of a shared text is unknown: an empty sender is classified as UNKNOWN, never as an ID. */
        const val SHARED_SENDER = ""
    }
}
