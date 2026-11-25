// ============================================================================================
// MIRSAD CONTRACTS — owned by the lead. Every workstream compiles against this file.
// Pure Kotlin: no Android imports anywhere in :core.
// Do not change signatures here without the lead; add new types in your own package instead.
// ============================================================================================
package app.mirsad.core.contract

import kotlinx.serialization.Serializable

/** Where the event came from. */
@Serializable
enum class Channel { CALL, SMS, CHAT }

/** The three decision levels. ALLOW: nothing happens. WARN: original stays, caution added. HOLD: see README. */
@Serializable
enum class Level { ALLOW, WARN, HOLD }

@Serializable
enum class Sensitivity { RELAXED, BALANCED, STRICT }

/** Detected language of the text. LATIN_ARABIC = Arabic written in Latin letters ("Arabizi"). */
@Serializable
enum class Language { EN, AR, LATIN_ARABIC, UNKNOWN }

/** How the sender was identified. */
@Serializable
enum class SenderType {
    /** A phone number (unknown sender). */
    NUMBER,
    /** An alphanumeric sender ID such as "ADCB" or "Aramex". */
    ALPHANUMERIC,
    /** A display name, treated as a saved contact. */
    CONTACT,
    UNKNOWN,
}

/** Input to the engine. One per incoming call, message or shared text. */
data class Event(
    val channel: Channel,
    /** Raw sender as seen: a number, an alphanumeric ID, or a display name. */
    val sender: String,
    /** Message text, or null for a call or hidden content. */
    val text: String?,
    /** Source app package, e.g. "com.whatsapp". Null for calls. */
    val appPackage: String?,
    /** Epoch millis. */
    val timestamp: Long,
    /** True when the title parsed as a name (treated as a saved contact). */
    val senderLooksLikeContact: Boolean,
    /** True when the system hid the notification content (e.g. Android 15+ OTP). Never a scam. */
    val contentHidden: Boolean = false,
)

/**
 * Stable reason codes. Use ONLY these codes in Reason.code (add new ones here, never ad hoc strings),
 * so the UI can translate every reason into plain Arabic/English.
 */
object ReasonCodes {
    // Sender
    const val SENDER_BLOCKLISTED = "SENDER_BLOCKLISTED"
    const val SENDER_ALLOWLISTED = "SENDER_ALLOWLISTED"
    const val SENDER_LOOKS_LIKE_CONTACT = "SENDER_LOOKS_LIKE_CONTACT"
    /** The displayed name is the "Known Scammer" contact Mirsad contact sync writes: a block signal, not a contact. */
    const val SENDER_KNOWN_SCAMMER_CONTACT = "SENDER_KNOWN_SCAMMER_CONTACT"
    const val SENDER_PLAIN_NUMBER_CLAIMS_ENTITY = "SENDER_PLAIN_NUMBER_CLAIMS_ENTITY"
    const val SENDER_FOREIGN_CODE_UAE_ENTITY = "SENDER_FOREIGN_CODE_UAE_ENTITY"
    const val SENDER_ONE_RING_PATTERN = "SENDER_ONE_RING_PATTERN"
    const val SENDER_INTERNATIONAL_CALL = "SENDER_INTERNATIONAL_CALL"
    const val SENDER_SEEN_IN_HELD_MESSAGE = "SENDER_SEEN_IN_HELD_MESSAGE"
    const val SENDER_OTP_FROM_ALPHANUMERIC = "SENDER_OTP_FROM_ALPHANUMERIC"

    // Links
    const val LINK_SHORTENER = "LINK_SHORTENER"
    const val LINK_IP_HOST = "LINK_IP_HOST"
    const val LINK_PUNYCODE_OR_MIXED_SCRIPT = "LINK_PUNYCODE_OR_MIXED_SCRIPT"
    const val LINK_PLAIN_HTTP = "LINK_PLAIN_HTTP"
    const val LINK_HIGH_RISK_TLD = "LINK_HIGH_RISK_TLD"
    const val LINK_LOOKALIKE_OFFICIAL = "LINK_LOOKALIKE_OFFICIAL"
    const val LINK_BRAND_IN_HOST_NOT_OFFICIAL = "LINK_BRAND_IN_HOST_NOT_OFFICIAL"
    const val LINK_BLOCKLISTED_DOMAIN = "LINK_BLOCKLISTED_DOMAIN"
    const val LINK_PRESENT = "LINK_PRESENT"

    // Content
    const val CONTENT_URGENCY = "CONTENT_URGENCY"
    const val CONTENT_THREAT = "CONTENT_THREAT"
    const val CONTENT_CREDENTIAL_REQUEST = "CONTENT_CREDENTIAL_REQUEST"
    const val CONTENT_SMALL_FEE_LINK = "CONTENT_SMALL_FEE_LINK"
    const val CONTENT_PRIZE = "CONTENT_PRIZE"
    const val CONTENT_JOB_OFFER = "CONTENT_JOB_OFFER"
    const val CONTENT_INVESTMENT = "CONTENT_INVESTMENT"
    const val CONTENT_REMOTE_ACCESS_APP = "CONTENT_REMOTE_ACCESS_APP"
    const val CONTENT_MOVE_TO_MESSENGER = "CONTENT_MOVE_TO_MESSENGER"
    const val CONTENT_PAYMENT_REQUEST = "CONTENT_PAYMENT_REQUEST"
    const val CONTENT_NEW_NUMBER_RELATIVE = "CONTENT_NEW_NUMBER_RELATIVE"
    const val CONTENT_IMPERSONATES_ENTITY = "CONTENT_IMPERSONATES_ENTITY"
    const val CONTENT_OTP_REQUEST = "CONTENT_OTP_REQUEST"

    // Fingerprint / lists
    const val FINGERPRINT_BLOCKLISTED = "FINGERPRINT_BLOCKLISTED"
    const val FINGERPRINT_KNOWN_GOOD = "FINGERPRINT_KNOWN_GOOD"

    // Classifier
    const val MODEL_SCORE = "MODEL_SCORE"

    // Gate / meta
    const val CONTENT_HIDDEN = "CONTENT_HIDDEN"
    const val ENGINE_TIMEOUT = "ENGINE_TIMEOUT"
    const val ENGINE_ERROR = "ENGINE_ERROR"
}

/** One reason for a verdict. [weight] is in [-1, 1]; negative weights are "safe" signals. */
@Serializable
data class Reason(
    val code: String,
    val weight: Double,
    /** Optional short detail (e.g. the offending host). Never raw message text. */
    val detail: String? = null,
    /**
     * Hard evidence: a blocklisted/lookalike link, blocklisted sender or fingerprint, or a credential/payment
     * request. HOLD requires at least one hard reason (see HOLD gate in the README).
     */
    val hard: Boolean = false,
)

@Serializable
enum class ArtifactType { PHONE, URL, DOMAIN, IBAN, EMAIL, WALLET, HANDLE }

/** An extracted artifact. Phone values are E.164 (+971...). Domains are registrable domains. */
@Serializable
data class Artifact(val type: ArtifactType, val value: String)

/** Output of the engine. */
@Serializable
data class Verdict(
    /** Combined score in [0, 1]. */
    val score: Double,
    val level: Level,
    val reasons: List<Reason>,
    val artifacts: List<Artifact>,
    /** 64-bit SimHash of the normalised, masked text, as 16 lowercase hex chars. "0" * 16 when no text. */
    val fingerprint: String,
    val latencyMs: Long,
    val language: Language = Language.UNKNOWN,
    /** Identifies the model used by stage 2 (e.g. "lr-ngram-v1"), or "none". */
    val modelVersion: String = "none",
    /** Identifies the rules file used by stage 1. */
    val rulesVersion: String = "unknown",
) {
    val hardReasons: List<Reason> get() = reasons.filter { it.hard }
}

/** Everything the engine needs beyond the event. Supplied by the app from Room on every call. */
data class EngineContext(
    val sensitivity: Sensitivity = Sensitivity.BALANCED,
    /** E.164 numbers, alphanumeric IDs or names on the allow list (normalised, case-insensitive compare). */
    val allowedSenders: Set<String> = emptySet(),
    val blockedSenders: Set<String> = emptySet(),
    /** Registrable domains on the blocklist. */
    val blockedDomains: Set<String> = emptySet(),
    /** Fingerprints (hex) on the blocklist. */
    val blockedFingerprints: Set<String> = emptySet(),
    /** Fingerprints marked known-good through "Not a scam". */
    val knownGoodFingerprints: Set<String> = emptySet(),
    /** E.164 numbers that appeared as sender in a HELD message in the last 7 days. */
    val recentlyHeldNumbers: Set<String> = emptySet(),
    /** Calls use stage 1 only (1 s budget). */
    val stageOneOnly: Boolean = false,
)

/** The detection engine. Must be safe to call from any thread and must never throw. */
interface ScamEngine {
    fun analyse(event: Event, context: EngineContext = EngineContext()): Verdict
}

/** Stage 2 classifier. Returns P(scam) in [0, 1] for already-normalised text. */
interface Classifier {
    val modelVersion: String
    fun scoreScam(normalisedText: String): Double
}

/** Used until the trained model is wired in; contributes nothing. */
object NoopClassifier : Classifier {
    override val modelVersion: String = "none"
    override fun scoreScam(normalisedText: String): Double = 0.0
}

// -------------------------------------------------------------------------------------------
// Incidents, lists, feedback, settings — storage contracts implemented in :app with Room.
// -------------------------------------------------------------------------------------------

/** How an incident entered Mirsad. */
@Serializable
enum class IncidentSource { NOTIFICATION, CALL_SCREENING, SHARE, DEMO, MANUAL }

@Serializable
enum class FeedbackVerdict { NONE, FALSE_POSITIVE, CONFIRMED_SCAM }

@Serializable
data class Incident(
    val id: Long = 0,
    val createdAt: Long,
    val channel: Channel,
    val sender: String,
    val senderType: SenderType,
    val appPackage: String?,
    /** Original text as seen. Kept locally only; never leaves the phone unless the user ticks the box. */
    val text: String?,
    val level: Level,
    val score: Double,
    val reasons: List<Reason>,
    val artifacts: List<Artifact>,
    val fingerprint: String,
    val latencyMs: Long,
    val language: Language,
    val modelVersion: String,
    val source: IncidentSource,
    /** True for Demo and test incidents. Police shortcuts are disabled for synthetic incidents. */
    val synthetic: Boolean,
    val feedback: FeedbackVerdict = FeedbackVerdict.NONE,
    /** Set when the original notification was removed and a copy kept in Quarantine. */
    val notificationRemoved: Boolean = false,
    /** Notification key of the source notification, when known. */
    val notificationKey: String? = null,
    /** The original notification title (e.g. sender name shown by the source app). */
    val title: String? = null,
)

@Serializable
enum class ListKind { ALLOW_SENDER, BLOCK_SENDER, BLOCK_DOMAIN, BLOCK_FINGERPRINT, KNOWN_GOOD_FINGERPRINT }

@Serializable
data class ListEntry(
    val id: Long = 0,
    val kind: ListKind,
    /** Normalised value: E.164 number, lowercase alphanumeric ID, lowercase registrable domain, or hex fingerprint. */
    val value: String,
    val note: String? = null,
    val createdAt: Long,
    /** "user", "not_a_scam", "import:<file>" ... */
    val origin: String = "user",
)

@Serializable
data class Feedback(
    val id: Long = 0,
    val incidentId: Long,
    val createdAt: Long,
    val verdict: FeedbackVerdict,
    val fingerprint: String,
    val reasonCodes: List<String>,
    val senderType: SenderType,
    val modelVersion: String,
    val level: Level,
    val score: Double,
    /** Stored so wrong verdicts become new labelled rows on export. */
    val text: String?,
    val language: Language,
)

@Serializable
data class IncidentFilter(
    val channel: Channel? = null,
    val level: Level? = null,
    val includeAllowed: Boolean = false,
)

interface IncidentStore {
    suspend fun insert(incident: Incident): Long
    suspend fun get(id: Long): Incident?
    suspend fun update(incident: Incident)
    fun observeRecent(limit: Int = 20): kotlinx.coroutines.flow.Flow<List<Incident>>
    fun observe(filter: IncidentFilter = IncidentFilter()): kotlinx.coroutines.flow.Flow<List<Incident>>
    /** Counts of WARN+HOLD incidents since [sinceEpochMillis] (0 = all time). */
    suspend fun countFlagged(sinceEpochMillis: Long): Int
    /** E.164 sender numbers of HELD incidents created after [sinceEpochMillis]. For the cross-channel rule. */
    suspend fun heldNumbersSince(sinceEpochMillis: Long): Set<String>
    /** Quarantine retention: delete incidents older than 30 days. */
    suspend fun purgeOlderThan(epochMillis: Long)
    suspend fun deleteAll()
}

interface ListStore {
    suspend fun add(entry: ListEntry): Long
    /** Removes every entry imported from one source (ListEntry.origin); returns how many were removed. */
    suspend fun removeOrigin(origin: String): Int
    suspend fun remove(id: Long)
    suspend fun removeValue(kind: ListKind, value: String)
    suspend fun contains(kind: ListKind, value: String): Boolean
    fun observe(kind: ListKind): kotlinx.coroutines.flow.Flow<List<ListEntry>>
    suspend fun values(kind: ListKind): Set<String>
    suspend fun deleteAll()
}

interface FeedbackStore {
    suspend fun add(feedback: Feedback): Long
    suspend fun all(): List<Feedback>
    suspend fun deleteAll()
}

/** User settings. Implemented in :app (SharedPreferences or DataStore). */
data class Settings(
    /** "system", "en" or "ar". */
    val language: String = "system",
    val sensitivity: Sensitivity = Sensitivity.BALANCED,
    /** Packages the notification listener watches. */
    val monitoredPackages: Set<String> = DefaultPackages.ALL,
    val onboardingDone: Boolean = false,
)

object DefaultPackages {
    const val GOOGLE_MESSAGES = "com.google.android.apps.messaging"
    const val AOSP_MESSAGING = "com.android.messaging"
    const val SAMSUNG_MESSAGES = "com.samsung.android.messaging"
    const val WHATSAPP = "com.whatsapp"
    const val WHATSAPP_BUSINESS = "com.whatsapp.w4b"
    const val TELEGRAM = "org.telegram.messenger"
    const val BOTIM = "im.thebot.messenger"
    val ALL: Set<String> = setOf(
        GOOGLE_MESSAGES, AOSP_MESSAGING, SAMSUNG_MESSAGES, WHATSAPP, WHATSAPP_BUSINESS, TELEGRAM, BOTIM,
    )
}

interface SettingsStore {
    fun observe(): kotlinx.coroutines.flow.Flow<Settings>
    suspend fun get(): Settings
    suspend fun update(transform: (Settings) -> Settings)
}

// -------------------------------------------------------------------------------------------
// Pipeline: engine + storage + notices. Implemented in :app (workstream D). UI calls only this.
// -------------------------------------------------------------------------------------------

interface IncidentPipeline {
    /**
     * Runs the real engine on [event], stores an Incident, posts the right notice (WARN caution / HOLD notice),
     * and returns the stored incident. [synthetic] marks Demo/test runs. Safe to call off the main thread only.
     */
    suspend fun process(event: Event, source: IncidentSource, synthetic: Boolean): Incident

    /**
     * "Not a scam": marks the incident as a false positive, adds the sender to the allow list, adds the
     * fingerprint to the known-good list, posts a normal notification with the original sender and text
     * that opens the source app, and returns an undo token.
     */
    suspend fun markNotScam(incidentId: Long): UndoToken

    /** Reverts [markNotScam]: removes the list entries it added and clears the feedback mark. */
    suspend fun undoNotScam(token: UndoToken)

    /** Marks an incident as a confirmed scam (feedback row) without any upload. */
    suspend fun confirmScam(incidentId: Long)

    /** Builds the EngineContext from the stores (lists, sensitivity, held numbers). */
    suspend fun engineContext(stageOneOnly: Boolean = false): EngineContext
}

@Serializable
data class UndoToken(
    val incidentId: Long,
    val addedListEntryIds: List<Long>,
    val previousFeedback: FeedbackVerdict,
)

// -------------------------------------------------------------------------------------------
// Reports — built in :core (workstream E), shared by the app only when the user taps Report.
// -------------------------------------------------------------------------------------------

/** Scam report, version 1. Serialised with kotlinx.serialization to pretty JSON. */
@Serializable
data class ScamReport(
    val reportId: String,
    val version: Int = 1,
    val createdAt: String,
    val channel: Channel,
    val level: Level,
    val score: Double,
    val reasonCodes: List<String>,
    val fingerprint: String,
    val artifacts: ReportArtifacts,
    val language: Language,
    val appVersion: String,
    val modelVersion: String,
    val synthetic: Boolean,
    /** Only when the user ticked the box on the preview screen. */
    val text: String? = null,
)

@Serializable
data class ReportArtifacts(
    val sender: String? = null,
    val senderType: SenderType = SenderType.UNKNOWN,
    val urls: List<String> = emptyList(),
    val domains: List<String> = emptyList(),
    val ibans: List<String> = emptyList(),
    val emails: List<String> = emptyList(),
    val wallets: List<String> = emptyList(),
    val handles: List<String> = emptyList(),
    val phones: List<String> = emptyList(),
)

@Serializable
data class FalsePositiveReport(
    val reportId: String,
    val version: Int = 1,
    val createdAt: String,
    val fingerprint: String,
    val reasonCodes: List<String>,
    val senderType: SenderType,
    val modelVersion: String,
    val userVerdict: FeedbackVerdict,
    val appVersion: String,
    val synthetic: Boolean,
    val text: String? = null,
)

/** Plain-language preview of what a report contains and what it never contains. */
data class ReportPreview(
    val json: String,
    val included: List<String>,
    val excluded: List<String>,
)

interface ReportBuilder {
    fun scamReport(incident: Incident, includeText: Boolean, appVersion: String, now: Long): ScamReport
    fun falsePositiveReport(incident: Incident, includeText: Boolean, appVersion: String, now: Long): FalsePositiveReport
    fun preview(report: ScamReport): ReportPreview
    fun preview(report: FalsePositiveReport): ReportPreview
    fun toJson(report: ScamReport): String
    fun toJson(report: FalsePositiveReport): String
    /** Short bilingual summary for the Aman SMS/email draft. Never includes raw text. */
    fun amanSummary(incident: Incident): String
}

/** A parsed blocklist import file (Settings > Import blocklist). See app/src/main/assets/blocklist_example.json. */
@Serializable
data class BlocklistFile(
    val version: Int = 1,
    val issuedAt: String? = null,
    val issuer: String? = null,
    val note: String? = null,
    val numbers: List<String> = emptyList(),
    val domains: List<String> = emptyList(),
    val fingerprints: List<String> = emptyList(),
    /** Set on a list signed by the Mirsad portal (see BlocklistSignature): the signing key, its expiry and signature. */
    val keyId: String? = null,
    val expiresAt: String? = null,
    val signature: String? = null,
)

/**
 * One display order for reasons everywhere (incident screen, rows, notices): hard evidence first, then the other
 * signals against the message by weight, then the classifier's opinion, then the safe signals.
 */
object ReasonOrder {
    private fun rank(r: Reason): Int = when {
        r.hard -> 0
        r.code == ReasonCodes.MODEL_SCORE -> 2
        r.weight < 0.0 -> 3
        else -> 1
    }

    fun forDisplay(reasons: List<Reason>): List<Reason> =
        reasons.sortedWith(compareBy<Reason> { rank(it) }.thenByDescending { kotlin.math.abs(it.weight) })

    /** The [max] strongest reasons that count against the message. */
    fun top(reasons: List<Reason>, max: Int): List<Reason> =
        forDisplay(reasons.filter { it.weight > 0.0 }).take(max)
}

/** Turns the engine's compact reason details into something a person can read. Never contains message text. */
object ReasonDetail {
    /** A short display detail for [reason], or null when the raw detail adds nothing for a reader. */
    fun display(reason: Reason): String? {
        val d = reason.detail?.trim().orEmpty()
        if (d.isEmpty()) return null
        return when (reason.code) {
            // "entityId:host" -> the offending host
            ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL -> d.substringAfter(':')
            // "lookalike~official" -> "lookalike ≈ official"
            ReasonCodes.LINK_LOOKALIKE_OFFICIAL -> d.replace("~", " ≈ ")
            // "official:domain" -> the official domain
            ReasonCodes.LINK_PRESENT -> d.removePrefix("official:")
            ReasonCodes.CONTENT_SMALL_FEE_LINK, ReasonCodes.CONTENT_PAYMENT_REQUEST,
            ReasonCodes.CONTENT_CREDENTIAL_REQUEST,
            -> null
            else -> d
        }
    }
}
