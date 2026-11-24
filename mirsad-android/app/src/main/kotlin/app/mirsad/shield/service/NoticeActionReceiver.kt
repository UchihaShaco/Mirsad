package app.mirsad.shield.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.mirsad.core.contract.UndoToken
import app.mirsad.shield.MirsadApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/** Handles the Not a scam / Undo / Confirm scam actions on Mirsad notices. */
class NoticeActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in HANDLED) return
        val app = context.applicationContext
        val incidentId = intent.getLongExtra(EXTRA_INCIDENT_ID, -1L)
        val tokenJson = intent.getStringExtra(EXTRA_UNDO_TOKEN)
        val pending = goAsync()
        scope.launch {
            try {
                handle(app, action, incidentId, tokenJson)
            } catch (t: Throwable) {
                Log.e(TAG, "action $action failed for incident $incidentId", t)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun handle(app: Context, action: String, incidentId: Long, tokenJson: String?) {
        val container = MirsadApp.container(app)
        when (action) {
            ACTION_NOT_A_SCAM -> {
                if (incidentId <= 0) return
                val token = container.pipeline.markNotScam(incidentId)
                val incident = container.incidents.get(incidentId) ?: return
                // Replaces the plain restored copy with one that carries the Undo action.
                Notices.postRestored(app, incident, token)
            }
            ACTION_UNDO -> {
                val token = tokenJson?.let { runCatching { Json.decodeFromString(UndoToken.serializer(), it) }.getOrNull() }
                    ?: return
                container.pipeline.undoNotScam(token)
            }
            ACTION_CONFIRM_SCAM -> {
                if (incidentId <= 0) return
                container.pipeline.confirmScam(incidentId)
            }
        }
    }

    companion object {
        private const val TAG = "MirsadNoticeAction"
        const val ACTION_NOT_A_SCAM = "app.mirsad.shield.action.NOT_A_SCAM"
        const val ACTION_UNDO = "app.mirsad.shield.action.UNDO"
        const val ACTION_CONFIRM_SCAM = "app.mirsad.shield.action.CONFIRM_SCAM"
        const val EXTRA_INCIDENT_ID = "app.mirsad.shield.extra.INCIDENT_ID"
        const val EXTRA_UNDO_TOKEN = "app.mirsad.shield.extra.UNDO_TOKEN"
        private val HANDLED = setOf(ACTION_NOT_A_SCAM, ACTION_UNDO, ACTION_CONFIRM_SCAM)
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }
}
