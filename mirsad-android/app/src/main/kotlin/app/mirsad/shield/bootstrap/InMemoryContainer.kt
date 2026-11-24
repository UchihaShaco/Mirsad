package app.mirsad.shield.bootstrap

import android.content.Context
import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.FalsePositiveReport
import app.mirsad.core.contract.Feedback
import app.mirsad.core.contract.FeedbackStore
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentFilter
import app.mirsad.core.contract.IncidentPipeline
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.IncidentStore
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ListEntry
import app.mirsad.core.contract.ListKind
import app.mirsad.core.contract.ListStore
import app.mirsad.core.contract.ReportArtifacts
import app.mirsad.core.contract.ReportBuilder
import app.mirsad.core.contract.ReportPreview
import app.mirsad.core.contract.ScamEngine
import app.mirsad.core.contract.ScamReport
import app.mirsad.core.contract.SenderType
import app.mirsad.core.contract.Settings
import app.mirsad.core.contract.SettingsStore
import app.mirsad.core.contract.UndoToken
import app.mirsad.shield.AppContainer
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Bootstrap-only container: in-memory stores and a pipeline with no notices.
 * Lets the UI run on a device before Room and the services land (workstream D replaces it).
 */
class InMemoryContainer(@Suppress("unused") private val context: Context) : AppContainer {
    override val engine: ScamEngine = MirsadEngineFactory.create()
    override val incidents = MemIncidentStore()
    override val lists = MemListStore()
    override val feedback = MemFeedbackStore()
    override val settings = MemSettingsStore()
    override val reports: ReportBuilder = app.mirsad.core.report.DefaultReportBuilder()
    override val pipeline: IncidentPipeline = MemPipeline(engine, incidents, lists, feedback, settings)
}

class MemIncidentStore : IncidentStore {
    private val state = MutableStateFlow<List<Incident>>(emptyList())
    private var nextId = 1L
    override suspend fun insert(incident: Incident): Long {
        val id = nextId++
        state.value = state.value + incident.copy(id = id)
        return id
    }
    override suspend fun get(id: Long) = state.value.firstOrNull { it.id == id }
    override suspend fun update(incident: Incident) {
        state.value = state.value.map { if (it.id == incident.id) incident else it }
    }
    override fun observeRecent(limit: Int): Flow<List<Incident>> =
        state.map { l -> l.sortedByDescending { it.createdAt }.take(limit) }
    override fun observe(filter: IncidentFilter): Flow<List<Incident>> = state.map { l ->
        l.filter { (filter.includeAllowed || it.level != Level.ALLOW) &&
            (filter.channel == null || it.channel == filter.channel) &&
            (filter.level == null || it.level == filter.level) }
            .sortedByDescending { it.createdAt }
    }
    override suspend fun countFlagged(sinceEpochMillis: Long) =
        state.value.count { it.level != Level.ALLOW && it.createdAt >= sinceEpochMillis }
    override suspend fun heldNumbersSince(sinceEpochMillis: Long): Set<String> =
        state.value.filter { it.level == Level.HOLD && it.createdAt >= sinceEpochMillis && it.senderType == SenderType.NUMBER }
            .map { it.sender }.toSet()
    override suspend fun purgeOlderThan(epochMillis: Long) { state.value = state.value.filter { it.createdAt >= epochMillis } }
    override suspend fun deleteAll() { state.value = emptyList() }
}

class MemListStore : ListStore {
    private val state = MutableStateFlow<List<ListEntry>>(emptyList())
    private var nextId = 1L
    override suspend fun add(entry: ListEntry): Long { val id = nextId++; state.value = state.value + entry.copy(id = id); return id }
    override suspend fun remove(id: Long) { state.value = state.value.filter { it.id != id } }
    override suspend fun removeValue(kind: ListKind, value: String) { state.value = state.value.filter { !(it.kind == kind && it.value == value) } }
    override suspend fun contains(kind: ListKind, value: String) = state.value.any { it.kind == kind && it.value == value }
    override fun observe(kind: ListKind): Flow<List<ListEntry>> = state.map { l -> l.filter { it.kind == kind } }
    override suspend fun values(kind: ListKind): Set<String> = state.value.filter { it.kind == kind }.map { it.value }.toSet()
    override suspend fun deleteAll() { state.value = emptyList() }
}

class MemFeedbackStore : FeedbackStore {
    private val items = mutableListOf<Feedback>()
    private var nextId = 1L
    override suspend fun add(feedback: Feedback): Long { val id = nextId++; items += feedback.copy(id = id); return id }
    override suspend fun all(): List<Feedback> = items.toList()
    override suspend fun deleteAll() { items.clear() }
}

class MemSettingsStore : SettingsStore {
    private val state = MutableStateFlow(Settings())
    override fun observe(): Flow<Settings> = state
    override suspend fun get(): Settings = state.value
    override suspend fun update(transform: (Settings) -> Settings) { state.value = transform(state.value) }
}

class MemPipeline(
    private val engine: ScamEngine,
    private val incidents: IncidentStore,
    private val lists: ListStore,
    private val feedback: FeedbackStore,
    private val settings: SettingsStore,
) : IncidentPipeline {
    override suspend fun process(event: Event, source: IncidentSource, synthetic: Boolean): Incident {
        val verdict = engine.analyse(event, engineContext(event.channel == Channel.CALL))
        val senderType = when {
            event.senderLooksLikeContact -> SenderType.CONTACT
            event.sender.any { it.isDigit() } && event.sender.count { it.isDigit() } >= 6 -> SenderType.NUMBER
            event.sender.isNotBlank() -> SenderType.ALPHANUMERIC
            else -> SenderType.UNKNOWN
        }
        val incident = Incident(
            createdAt = event.timestamp, channel = event.channel, sender = event.sender, senderType = senderType,
            appPackage = event.appPackage, text = event.text, level = verdict.level, score = verdict.score,
            reasons = verdict.reasons, artifacts = verdict.artifacts, fingerprint = verdict.fingerprint,
            latencyMs = verdict.latencyMs, language = verdict.language, modelVersion = verdict.modelVersion,
            source = source, synthetic = synthetic,
        )
        val id = incidents.insert(incident)
        return incident.copy(id = id)
    }

    override suspend fun markNotScam(incidentId: Long): UndoToken {
        val inc = incidents.get(incidentId) ?: return UndoToken(incidentId, emptyList(), FeedbackVerdict.NONE)
        val now = System.currentTimeMillis()
        val ids = mutableListOf<Long>()
        ids += lists.add(ListEntry(kind = ListKind.ALLOW_SENDER, value = inc.sender, createdAt = now, origin = "not_a_scam"))
        ids += lists.add(ListEntry(kind = ListKind.KNOWN_GOOD_FINGERPRINT, value = inc.fingerprint, createdAt = now, origin = "not_a_scam"))
        incidents.update(inc.copy(feedback = FeedbackVerdict.FALSE_POSITIVE))
        feedback.add(Feedback(incidentId = inc.id, createdAt = now, verdict = FeedbackVerdict.FALSE_POSITIVE, fingerprint = inc.fingerprint,
            reasonCodes = inc.reasons.map { it.code }, senderType = inc.senderType, modelVersion = inc.modelVersion,
            level = inc.level, score = inc.score, text = inc.text, language = inc.language))
        return UndoToken(incidentId, ids, inc.feedback)
    }

    override suspend fun undoNotScam(token: UndoToken) {
        token.addedListEntryIds.forEach { lists.remove(it) }
        incidents.get(token.incidentId)?.let { incidents.update(it.copy(feedback = token.previousFeedback)) }
    }

    override suspend fun confirmScam(incidentId: Long) {
        incidents.get(incidentId)?.let { incidents.update(it.copy(feedback = FeedbackVerdict.CONFIRMED_SCAM)) }
    }

    override suspend fun engineContext(stageOneOnly: Boolean): EngineContext = EngineContext(
        sensitivity = settings.get().sensitivity,
        allowedSenders = lists.values(ListKind.ALLOW_SENDER),
        blockedSenders = lists.values(ListKind.BLOCK_SENDER),
        blockedDomains = lists.values(ListKind.BLOCK_DOMAIN),
        blockedFingerprints = lists.values(ListKind.BLOCK_FINGERPRINT),
        knownGoodFingerprints = lists.values(ListKind.KNOWN_GOOD_FINGERPRINT),
        recentlyHeldNumbers = incidents.heldNumbersSince(System.currentTimeMillis() - 7L * 24 * 3600 * 1000),
        stageOneOnly = stageOneOnly,
    )
}

/** Minimal builder until workstream E delivers the real one in :core. */
class StubReportBuilder : ReportBuilder {
    private val json = Json { prettyPrint = true; encodeDefaults = true }
    override fun scamReport(incident: Incident, includeText: Boolean, appVersion: String, now: Long) = ScamReport(
        reportId = "stub-${incident.id}", createdAt = now.toString(), channel = incident.channel, level = incident.level,
        score = incident.score, reasonCodes = incident.reasons.map { it.code }, fingerprint = incident.fingerprint,
        artifacts = ReportArtifacts(sender = incident.sender, senderType = incident.senderType), language = incident.language,
        appVersion = appVersion, modelVersion = incident.modelVersion, synthetic = incident.synthetic,
        text = if (includeText) incident.text else null,
    )
    override fun falsePositiveReport(incident: Incident, includeText: Boolean, appVersion: String, now: Long) = FalsePositiveReport(
        reportId = "stub-fp-${incident.id}", createdAt = now.toString(), fingerprint = incident.fingerprint,
        reasonCodes = incident.reasons.map { it.code }, senderType = incident.senderType, modelVersion = incident.modelVersion,
        userVerdict = incident.feedback, appVersion = appVersion, synthetic = incident.synthetic,
        text = if (includeText) incident.text else null,
    )
    override fun preview(report: ScamReport) = ReportPreview(toJson(report), listOf("stub"), listOf("stub"))
    override fun preview(report: FalsePositiveReport) = ReportPreview(toJson(report), listOf("stub"), listOf("stub"))
    override fun toJson(report: ScamReport): String = json.encodeToString(report)
    override fun toJson(report: FalsePositiveReport): String = json.encodeToString(report)
    override fun amanSummary(incident: Incident) = "Mirsad report ${incident.id}"
}
