package app.mirsad.shield.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import app.mirsad.core.contract.Artifact
import app.mirsad.core.contract.ArtifactType
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Feedback
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.Language
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ListEntry
import app.mirsad.core.contract.ListKind
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.SenderType

/** One row per analysed call, message or shared text. Reasons and artifacts are JSON columns. */
@Entity(
    tableName = "incidents",
    indices = [Index("createdAt"), Index("level"), Index("sender"), Index("fingerprint")],
)
data class IncidentEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val createdAt: Long,
    val channel: Channel,
    val sender: String,
    val senderType: SenderType,
    val appPackage: String?,
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
    val synthetic: Boolean,
    val feedback: FeedbackVerdict,
    val notificationRemoved: Boolean,
    val notificationKey: String?,
    val title: String?,
)

/** Artifacts denormalised into their own table so numbers and domains can be queried across incidents. */
@Entity(
    tableName = "artifacts",
    indices = [Index("incidentId"), Index(value = ["type", "value"])],
)
data class ArtifactEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val incidentId: Long,
    val type: ArtifactType,
    val value: String,
)

/** Allow/block lists. A value is unique per kind. */
@Entity(
    tableName = "list_entries",
    indices = [Index(value = ["kind", "value"], unique = true)],
)
data class ListEntryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: ListKind,
    val value: String,
    val note: String?,
    val createdAt: Long,
    val origin: String,
)

/** User feedback ("Not a scam" / "Confirmed scam"); becomes labelled rows on export. */
@Entity(tableName = "feedback", indices = [Index("incidentId")])
data class FeedbackEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val incidentId: Long,
    val createdAt: Long,
    val verdict: FeedbackVerdict,
    val fingerprint: String,
    val reasonCodes: List<String>,
    val senderType: SenderType,
    val modelVersion: String,
    val level: Level,
    val score: Double,
    val text: String?,
    val language: Language,
)

// --- mapping to the contract types -------------------------------------------------------------

fun Incident.toEntity() = IncidentEntity(
    id = id, createdAt = createdAt, channel = channel, sender = sender, senderType = senderType,
    appPackage = appPackage, text = text, level = level, score = score, reasons = reasons, artifacts = artifacts,
    fingerprint = fingerprint, latencyMs = latencyMs, language = language, modelVersion = modelVersion,
    source = source, synthetic = synthetic, feedback = feedback, notificationRemoved = notificationRemoved,
    notificationKey = notificationKey, title = title,
)

fun IncidentEntity.toIncident() = Incident(
    id = id, createdAt = createdAt, channel = channel, sender = sender, senderType = senderType,
    appPackage = appPackage, text = text, level = level, score = score, reasons = reasons, artifacts = artifacts,
    fingerprint = fingerprint, latencyMs = latencyMs, language = language, modelVersion = modelVersion,
    source = source, synthetic = synthetic, feedback = feedback, notificationRemoved = notificationRemoved,
    notificationKey = notificationKey, title = title,
)

fun Incident.artifactEntities(incidentId: Long = id): List<ArtifactEntity> =
    artifacts.map { ArtifactEntity(incidentId = incidentId, type = it.type, value = it.value) }

fun ListEntry.toEntity() = ListEntryEntity(id = id, kind = kind, value = value, note = note, createdAt = createdAt, origin = origin)

fun ListEntryEntity.toListEntry() = ListEntry(id = id, kind = kind, value = value, note = note, createdAt = createdAt, origin = origin)

fun Feedback.toEntity() = FeedbackEntity(
    id = id, incidentId = incidentId, createdAt = createdAt, verdict = verdict, fingerprint = fingerprint,
    reasonCodes = reasonCodes, senderType = senderType, modelVersion = modelVersion, level = level, score = score,
    text = text, language = language,
)

fun FeedbackEntity.toFeedback() = Feedback(
    id = id, incidentId = incidentId, createdAt = createdAt, verdict = verdict, fingerprint = fingerprint,
    reasonCodes = reasonCodes, senderType = senderType, modelVersion = modelVersion, level = level, score = score,
    text = text, language = language,
)
