package app.mirsad.shield.service

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.Level
import app.mirsad.shield.MirsadApp
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Screens incoming calls with stage 1 only, inside a 1 s budget. HOLD rejects the call (it stays in the call
 * log, no missed-call notification); WARN lets it ring with a heads-up; anything else, including a timeout or
 * an error, allows the call. Responds exactly once.
 */
class MirsadCallScreeningService : CallScreeningService() {
    override fun onScreenCall(callDetails: Call.Details) {
        val response = try {
            screen(callDetails)
        } catch (t: Throwable) {
            Log.e(TAG, "screening failed; allowing", t)
            allow()
        }
        respondToCall(callDetails, response)
    }

    private fun screen(callDetails: Call.Details): CallResponse {
        if (callDetails.callDirection != Call.Details.DIRECTION_INCOMING) return allow()
        val number = callDetails.handle?.schemeSpecificPart?.trim().orEmpty()
        if (number.isBlank()) {
            Log.i(TAG, "incoming call without a number; allowed")
            return allow()
        }
        val pipeline = MirsadApp.container(this).pipeline
        val event = Event(
            channel = Channel.CALL,
            sender = number,
            text = null,
            appPackage = null,
            timestamp = System.currentTimeMillis(),
            senderLooksLikeContact = false,
        )
        val incident: Incident? = runBlocking {
            withTimeoutOrNull(BUDGET_MS) { pipeline.process(event, IncidentSource.CALL_SCREENING, synthetic = false) }
        }
        Log.i(TAG, "call from $number -> ${incident?.level ?: "ALLOW (timeout)"} incident=${incident?.id}")
        return if (incident?.level == Level.HOLD) {
            CallResponse.Builder()
                .setDisallowCall(true)
                .setRejectCall(true)
                .setSkipCallLog(false)
                .setSkipNotification(true)
                .build()
        } else {
            allow()
        }
    }

    private fun allow(): CallResponse = CallResponse.Builder().build()

    private companion object {
        const val TAG = "MirsadCallScreen"
        const val BUDGET_MS = 1_000L
    }
}
