package app.mirsad.shield.report

import android.content.Context
import android.net.Uri
import app.mirsad.core.contract.Incident

/**
 * Stub signatures (workstream E fills the bodies). The UI calls only these.
 * Nothing leaves the phone unless the user taps Report and then picks an app in the share sheet.
 */
object ReportActions {
    /** Opens the system share sheet with the report JSON as plain text. Also saves a copy for adb pull. */
    fun shareJson(context: Context, fileNameHint: String, json: String): Boolean = false

    /** Saves the JSON under the app's external files dir (reports/) and returns the file path, or null. */
    fun saveForAdb(context: Context, fileNameHint: String, json: String): String? = null

    /** Why the Aman shortcuts are disabled for this incident (demo/synthetic), or null when enabled. */
    fun amanDisabledReason(incident: Incident): AmanDisabledReason? =
        if (incident.synthetic) AmanDisabledReason.SYNTHETIC else null

    fun dialAman(context: Context): Boolean = false
    fun smsAman(context: Context, summary: String): Boolean = false
    fun emailAman(context: Context, subject: String, summary: String): Boolean = false
}

enum class AmanDisabledReason { SYNTHETIC }

/** Settings > Import blocklist. Reads a JSON file (see assets/blocklist_example.json) into the block lists. */
object BlocklistImporter {
    data class Result(val numbers: Int, val domains: Int, val fingerprints: Int, val error: String? = null)
    suspend fun import(context: Context, uri: Uri): Result = Result(0, 0, 0, "not implemented")
}
