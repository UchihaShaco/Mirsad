package app.mirsad.shield.service

import android.telecom.Call
import android.telecom.CallScreeningService

/** Stub. Workstream D implements screening (stage 1 only, 1 s budget, allow on timeout). */
class MirsadCallScreeningService : CallScreeningService() {
    override fun onScreenCall(callDetails: Call.Details) {
        respondToCall(callDetails, CallResponse.Builder().build())
    }
}
