package app.mirsad.shield.service

import android.content.Context
import android.util.Log
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Feedback
import app.mirsad.core.contract.FeedbackStore
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentPipeline
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.IncidentStore
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ListEntry
import app.mirsad.core.contract.ListKind
import app.mirsad.core.contract.ListStore
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.ScamEngine
import app.mirsad.core.contract.SenderType
import app.mirsad.core.contract.SettingsStore
import app.mirsad.core.contract.UndoToken
import app.mirsad.core.contract.Verdict
import app.mirsad.shield.data.UndoableFeedbackStore

/**
 * Engine + storage + notices. Everything the listener, call screening, share target and UI do with an
 * event goes through here.
 */
class DefaultPipeline(
    context: Context,
    private val engine: ScamEngine,
    private val incidents: IncidentStore,
    private val lists: ListStore,
    private val feedback: FeedbackStore,
    private val settings: SettingsStore,
) : IncidentPipeline {
    private val app = context.applicationContext

    override suspend fun process(event: Event, source: IncidentSource, synthetic: Boolean): Incident {
        val senderType = Senders.senderTypeOf(event.sender, event.senderLooksLikeContact)
        val sender = if (senderType == SenderType.NUMBER) Senders.toE164(event.sender) else event.sender.trim()
        val normalised = if (sender != event.sender) event.copy(sender = sender) else event
        val context = engineContext(stageOneOnly = event.channel == Channel.CALL)
        val verdict = try {
            engine.analyse(normalised, context)
        } catch (t: Throwable) {
            Log.e(TAG, "engine threw; allowing", t)
            errorVerdict()
        }
        val incident = Incident(
            createdAt = event.timestamp,
            channel = event.channel,
            sender = sender,
            senderType = senderType,
            appPackage = event.appPackage,
            text = event.text,
            level = verdict.level,
            score = verdict.score,
            reasons = verdict.reasons,
            artifacts = verdict.artifacts,
            fingerprint = verdict.fingerprint,
            latencyMs = verdict.latencyMs,
            language = verdict.language,
            modelVersion = verdict.modelVersion,
            source = source,
            synthetic = synthetic,
            title = event.sender.trim().takeIf { it.isNotEmpty() },
        )
        // Privacy: traffic the live services allow is not stored. Mirsad keeps a copy only of what it warned
        // about or held; Demo, share and manual checks are stored because the user asked for that verdict.
        val persist = verdict.level != Level.ALLOW || source !in LIVE_SOURCES
        val stored = if (persist) incident.copy(id = incidents.insert(incident)) else incident
        Log.i(
            TAG,
            "incident #${stored.id} ${stored.level} ${stored.channel} source=$source synthetic=$synthetic " +
                "score=${"%.2f".format(stored.score)} reasons=${stored.reasons.map { it.code }} latency=${stored.latencyMs}ms",
        )
        if (stored.level != Level.ALLOW && source in NOTIFYING_SOURCES) {
            runCatching { Notices.postIncident(app, stored) }.onFailure { Log.w(TAG, "notice failed", it) }
        }
        return stored
    }

    override suspend fun markNotScam(incidentId: Long): UndoToken {
        val incident = incidents.get(incidentId) ?: return UndoToken(incidentId, emptyList(), FeedbackVerdict.NONE)
        val now = System.currentTimeMillis()
        val added = mutableListOf<Long>()

        // The share target uses the placeholder sender "shared"; never allow-list it.
        if (incident.source != IncidentSource.SHARE && incident.senderType != SenderType.UNKNOWN) {
            val value = Senders.listValue(incident.sender, incident.senderType)
            if (value.isNotBlank() && !lists.contains(ListKind.ALLOW_SENDER, value)) {
                added += lists.add(
                    ListEntry(kind = ListKind.ALLOW_SENDER, value = value, note = incident.title, createdAt = now, origin = ORIGIN_NOT_A_SCAM),
                )
            }
        }
        val fingerprint = incident.fingerprint
        if (fingerprint.isNotBlank() && fingerprint.any { it != '0' } &&
            !lists.contains(ListKind.KNOWN_GOOD_FINGERPRINT, fingerprint)
        ) {
            added += lists.add(
                ListEntry(kind = ListKind.KNOWN_GOOD_FINGERPRINT, value = fingerprint, createdAt = now, origin = ORIGIN_NOT_A_SCAM),
            )
        }

        incidents.update(incident.copy(feedback = FeedbackVerdict.FALSE_POSITIVE))
        feedback.add(feedbackRow(incident, FeedbackVerdict.FALSE_POSITIVE, now))

        Notices.cancelIncident(app, incident.id)
        if (incident.level == Level.HOLD) {
            runCatching { Notices.postRestored(app, incident, null) }.onFailure { Log.w(TAG, "restore notice failed", it) }
        }
        Log.i(TAG, "incident #${incident.id} marked not a scam; list entries=$added")
        return UndoToken(incidentId = incident.id, addedListEntryIds = added.filter { it > 0 }, previousFeedback = incident.feedback)
    }

    /** Removes the list entries and the FALSE_POSITIVE feedback row added by [markNotScam], re-posts the notice. */
    override suspend fun undoNotScam(token: UndoToken) {
        token.addedListEntryIds.forEach { lists.remove(it) }
        (feedback as? UndoableFeedbackStore)?.removeForIncident(token.incidentId, FeedbackVerdict.FALSE_POSITIVE)
        val incident = incidents.get(token.incidentId) ?: return
        val reverted = incident.copy(feedback = token.previousFeedback)
        incidents.update(reverted)
        Notices.cancelRestored(app, incident.id)
        if (reverted.level != Level.ALLOW) {
            runCatching { Notices.postIncident(app, reverted) }.onFailure { Log.w(TAG, "notice failed", it) }
        }
        Log.i(TAG, "incident #${incident.id} not-a-scam undone")
    }

    override suspend fun confirmScam(incidentId: Long) {
        val incident = incidents.get(incidentId) ?: return
        val now = System.currentTimeMillis()
        incidents.update(incident.copy(feedback = FeedbackVerdict.CONFIRMED_SCAM))
        feedback.add(feedbackRow(incident, FeedbackVerdict.CONFIRMED_SCAM, now))
        Notices.cancelIncident(app, incident.id)
        Log.i(TAG, "incident #${incident.id} confirmed scam")
    }

    override suspend fun engineContext(stageOneOnly: Boolean): EngineContext = EngineContext(
        sensitivity = settings.get().sensitivity,
        allowedSenders = lists.values(ListKind.ALLOW_SENDER),
        blockedSenders = lists.values(ListKind.BLOCK_SENDER),
        blockedDomains = lists.values(ListKind.BLOCK_DOMAIN),
        blockedFingerprints = lists.values(ListKind.BLOCK_FINGERPRINT),
        knownGoodFingerprints = lists.values(ListKind.KNOWN_GOOD_FINGERPRINT),
        recentlyHeldNumbers = incidents.heldNumbersSince(System.currentTimeMillis() - HELD_WINDOW_MS),
        stageOneOnly = stageOneOnly,
    )

    private fun feedbackRow(incident: Incident, verdict: FeedbackVerdict, now: Long) = Feedback(
        incidentId = incident.id,
        createdAt = now,
        verdict = verdict,
        fingerprint = incident.fingerprint,
        reasonCodes = incident.reasons.map { it.code },
        senderType = incident.senderType,
        modelVersion = incident.modelVersion,
        level = incident.level,
        score = incident.score,
        text = incident.text,
        language = incident.language,
    )

    private fun errorVerdict() = Verdict(
        score = 0.0,
        level = Level.ALLOW,
        reasons = listOf(Reason(ReasonCodes.ENGINE_ERROR, 0.0)),
        artifacts = emptyList(),
        fingerprint = ZERO_FINGERPRINT,
        latencyMs = 0,
    )

    companion object {
        private const val TAG = "MirsadPipeline"
        const val ORIGIN_NOT_A_SCAM = "not_a_scam"
        private const val HELD_WINDOW_MS = 7L * 24 * 3600 * 1000
        private const val ZERO_FINGERPRINT = "0000000000000000"

        /** Background sources: their ALLOW verdicts are never persisted. */
        private val LIVE_SOURCES = setOf(IncidentSource.NOTIFICATION, IncidentSource.CALL_SCREENING)

        /** Sources whose incidents are surfaced as notices. Share/manual checks show their result on screen. */
        private val NOTIFYING_SOURCES = setOf(IncidentSource.NOTIFICATION, IncidentSource.CALL_SCREENING, IncidentSource.DEMO)
    }
}
