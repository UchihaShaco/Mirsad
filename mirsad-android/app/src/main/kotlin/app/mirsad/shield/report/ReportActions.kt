package app.mirsad.shield.report

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.ListEntry
import app.mirsad.core.contract.ListKind
import app.mirsad.core.contract.ListStore
import app.mirsad.core.report.BlocklistParser
import app.mirsad.core.report.BlocklistSignature
import app.mirsad.shield.MirsadApp
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The UI calls only these. Nothing leaves the phone unless the user taps Report and then picks an app in the
 * share sheet: every method here hands an Intent to the system and returns; there is no network code.
 *
 * The manifest has no `<queries>` element, so on API 30+ `resolveActivity` cannot tell whether a dialer, SMS or
 * email app exists. The documented way is to start the activity and catch ActivityNotFoundException, which is
 * what [start] does; every method returns false when no app can handle the intent.
 */
object ReportActions {
    private const val TAG = "MirsadReport"
    private const val REPORTS_DIR = "reports"
    private val reportIdPattern = Regex("\"reportId\"\\s*:\\s*\"([^\"]+)\"")

    /** Opens the system share sheet with the report JSON as text. Also saves a copy for adb pull. */
    fun shareJson(context: Context, fileNameHint: String, json: String): Boolean {
        saveForAdb(context, fileNameHint, json)
        val id = reportIdPattern.find(json)?.groupValues?.get(1) ?: fileNameHint
        val subject = if (json.contains("\"userVerdict\"")) "Mirsad false-positive report $id" else "Mirsad scam report $id"
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/json"
            putExtra(Intent.EXTRA_TEXT, json)
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TITLE, subject)
        }
        return start(context, Intent.createChooser(send, subject))
    }

    /**
     * Saves the JSON under the app-private filesDir/reports, readable over adb on this debug build with
     * `adb exec-out run-as app.mirsad.shield cat files/reports/<name>.json` (scripts/push_report_to_mirsad.sh).
     * Returns the absolute path, or null when neither could be written.
     */
    /** Removes every report copy Mirsad saved. Called by Settings > Delete all data. */
    fun deleteSavedReports(context: Context) {
        runCatching { File(context.filesDir, REPORTS_DIR).deleteRecursively() }
        runCatching { context.getExternalFilesDir(REPORTS_DIR)?.deleteRecursively() } // copies from earlier builds
    }

    fun saveForAdb(context: Context, fileNameHint: String, json: String): String? {
        val name = safeFileName(fileNameHint)
        // App-private storage only: no other app can read it. "Delete all data" removes it (see deleteSavedReports).
        val candidates = listOf(File(context.filesDir, REPORTS_DIR))
        for (dir in candidates) {
            try {
                if (!dir.isDirectory && !dir.mkdirs()) continue
                val file = File(dir, name)
                file.writeText(json, Charsets.UTF_8)
                return file.absolutePath
            } catch (e: IOException) {
                Log.w(TAG, "Could not save the report under $dir", e)
            } catch (e: SecurityException) {
                Log.w(TAG, "Not allowed to save the report under $dir", e)
            }
        }
        return null
    }

    /** Why the Aman shortcuts are disabled for this incident (demo/synthetic), or null when enabled. */
    fun amanDisabledReason(incident: Incident): AmanDisabledReason? =
        if (incident.synthetic) AmanDisabledReason.SYNTHETIC else null

    /** Opens the dialer with the Aman number filled in (ACTION_DIAL needs no permission; the user taps call). */
    fun dialAman(context: Context): Boolean {
        val phone = ReportChannels.aman(context).phone?.takeIf { it.isNotBlank() } ?: return false
        return start(context, Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")))
    }

    /** Opens the SMS app with the Aman short code and the summary as the draft body. */
    fun smsAman(context: Context, summary: String): Boolean {
        val number = ReportChannels.aman(context).sms?.takeIf { it.isNotBlank() } ?: return false
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$number")).putExtra("sms_body", summary)
        return start(context, intent)
    }

    /** Opens an email app with the Aman address, subject and summary as the draft. */
    fun emailAman(context: Context, subject: String, summary: String): Boolean {
        val email = ReportChannels.aman(context).email?.takeIf { it.isNotBlank() } ?: return false
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:$email")).apply {
            putExtra(Intent.EXTRA_EMAIL, arrayOf(email))
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TEXT, summary)
        }
        return start(context, intent)
    }

    private fun start(context: Context, intent: Intent): Boolean {
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            Log.i(TAG, "No app can handle ${intent.action}")
            false
        } catch (e: SecurityException) {
            Log.w(TAG, "Not allowed to start ${intent.action}", e)
            false
        }
    }

    private fun safeFileName(hint: String): String {
        val base = hint.trim().removeSuffix(".json")
            .replace(Regex("[^A-Za-z0-9._-]+"), "_")
            .trim('_', '.')
            .take(80)
            .ifEmpty { "mirsad-report" }
        return "$base.json"
    }
}

enum class AmanDisabledReason { SYNTHETIC }

/**
 * Settings > Import blocklist. Reads a JSON file (see assets/blocklist_example.json) into the block lists.
 *
 * A list the Mirsad portal signed with a key in assets/trusted_blocklist_keys.json is a police list: it replaces the
 * previous list from that key, so a number the police cleared disappears from the phone. A signed list that does not
 * verify, or has expired, is refused. A list without a signature is a personal list and is added as before.
 */
object BlocklistImporter {
    private const val MAX_BYTES = 2L * 1024 * 1024
    private const val TRUSTED_KEYS_ASSET = "trusted_blocklist_keys.json"
    private val keysJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    @kotlinx.serialization.Serializable
    private data class TrustedKeys(val keys: List<Key> = emptyList()) {
        @kotlinx.serialization.Serializable
        data class Key(val keyId: String, val issuer: String, val publicKey: String)
    }

    /** The portal keys this build trusts. An unreadable asset trusts nothing, so a signed list is refused, never trusted. */
    fun trustedKeys(context: Context): List<BlocklistSignature.TrustedKey> = runCatching {
        context.assets.open(TRUSTED_KEYS_ASSET).use { input ->
            keysJson.decodeFromString(TrustedKeys.serializer(), input.readBytes().toString(Charsets.UTF_8))
                .keys.map { BlocklistSignature.TrustedKey(it.keyId, it.issuer, it.publicKey) }
        }
    }.getOrDefault(emptyList())

    /**
     * Counts of entries added per list. [skipped] were already on the lists, [invalid] could not be normalised
     * (not a phone number, domain or fingerprint). [error] is set, with zero counts, when nothing was imported.
     */
    data class Result(
        val numbers: Int,
        val domains: Int,
        val fingerprints: Int,
        val error: String? = null,
        val skipped: Int = 0,
        val invalid: Int = 0,
    ) {
        val added: Int get() = numbers + domains + fingerprints
    }

    /** Set when the list was a verified police list: who issued it, its size, and how many old entries it replaced. */
    data class Police(val issuer: String, val numbers: Int, val fingerprints: Int, val replaced: Int)

    @Volatile var lastPolice: Police? = null
        private set

    suspend fun import(context: Context, uri: Uri): Result = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        val displayName = displayName(app, uri)
        val text = try {
            readLimited(app, uri) ?: return@withContext Result(0, 0, 0, "The file is larger than 2 MB")
        } catch (e: IOException) {
            return@withContext Result(0, 0, 0, "Could not read the file: ${e.message ?: "I/O error"}")
        } catch (e: SecurityException) {
            return@withContext Result(0, 0, 0, "No permission to read the file")
        }
        val parsed = try {
            BlocklistParser.parse(text)
        } catch (e: IllegalArgumentException) {
            return@withContext Result(0, 0, 0, e.message ?: "Not a blocklist file")
        }
        val now = System.currentTimeMillis()
        // The signature covers the values as written, so it is checked before normalisation.
        val check = BlocklistSignature.check(parsed, trustedKeys(app), now)
        if (check is BlocklistSignature.Check.Rejected) return@withContext Result(0, 0, 0, check.reason)
        val normalised = BlocklistParser.normalise(parsed)
        val lists = MirsadApp.container(app).lists
        val verified = check as? BlocklistSignature.Check.Verified
        val origin = if (verified != null) "police:${verified.key.keyId}" else "import:$displayName"
        val replaced = if (verified != null) lists.removeOrigin(origin) else 0
        lastPolice = verified?.let { Police(it.key.issuer, normalised.file.numbers.size, normalised.file.fingerprints.size, replaced) }
        val note = (verified?.key?.issuer ?: normalised.file.issuer)?.take(120)
        val n = addAll(lists, ListKind.BLOCK_SENDER, normalised.file.numbers, note, origin, now)
        val d = addAll(lists, ListKind.BLOCK_DOMAIN, normalised.file.domains, note, origin, now)
        val f = addAll(lists, ListKind.BLOCK_FINGERPRINT, normalised.file.fingerprints, note, origin, now)
        Result(
            numbers = n.first, domains = d.first, fingerprints = f.first,
            skipped = n.second + d.second + f.second,
            invalid = normalised.dropped,
        )
    }

    /** Returns (added, skipped). Values already on the list are skipped, never duplicated. */
    private suspend fun addAll(
        lists: ListStore,
        kind: ListKind,
        values: List<String>,
        note: String?,
        origin: String,
        now: Long,
    ): Pair<Int, Int> {
        var added = 0
        var skipped = 0
        for (value in values) {
            if (lists.contains(kind, value)) {
                skipped++
                continue
            }
            lists.add(ListEntry(kind = kind, value = value, note = note, createdAt = now, origin = origin))
            added++
        }
        return added to skipped
    }

    /** Reads at most 2 MB; returns null when the document is larger. */
    private fun readLimited(context: Context, uri: Uri): String? {
        val stream = context.contentResolver.openInputStream(uri) ?: throw IOException("The document could not be opened")
        stream.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
                if (total > MAX_BYTES) return null
                out.write(buffer, 0, n)
            }
            return out.toString("UTF-8")
        }
    }

    /** OpenableColumns.DISPLAY_NAME when the provider offers it, else the last path segment. Control chars stripped. */
    private fun displayName(context: Context, uri: Uri): String {
        var name: String? = null
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) name = cursor.getString(index)
            }
        } catch (e: RuntimeException) {
            // Some providers refuse the query; the path segment below is good enough for the origin label.
            Log.i(TAG, "Display name query failed: ${e.javaClass.simpleName}")
        }
        val raw = name?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.takeIf { it.isNotBlank() } ?: "file"
        return raw.replace(Regex("\\p{Cntrl}+"), "").trim().take(80).ifEmpty { "file" }
    }

    private const val TAG = "MirsadImport"
}
