package app.mirsad.core.report

import app.mirsad.core.contract.ArtifactType
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.FalsePositiveReport
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ReportArtifacts
import app.mirsad.core.contract.ReportBuilder
import app.mirsad.core.contract.ReportPreview
import app.mirsad.core.contract.ScamReport
import app.mirsad.core.contract.SenderType
import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.json.Json

/** The one JSON configuration every report uses: pretty, with defaults written out. */
object ReportJson {
    val pretty: Json = Json { prettyPrint = true; encodeDefaults = true }
}

/**
 * Builds the scam report (v1) and the false-positive report from an [Incident].
 *
 * Nothing here touches the network or the file system. Personal data rules:
 * - a saved contact's name never enters a report (sender = null, senderType = CONTACT);
 * - the message text enters only when the user ticked the box;
 * - the report never contains contacts, other messages, location, device identifiers or the user's own number,
 *   because nothing in [Incident] carries them.
 */
class DefaultReportBuilder : ReportBuilder {

    override fun scamReport(incident: Incident, includeText: Boolean, appVersion: String, now: Long): ScamReport {
        val grouped = incident.artifacts.groupBy({ it.type }, { it.value })
        fun of(type: ArtifactType): List<String> = grouped[type].orEmpty().map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        return ScamReport(
            reportId = reportId(incident),
            version = 1,
            createdAt = iso(now),
            channel = incident.channel,
            level = incident.level,
            score = round3(incident.score),
            reasonCodes = reasonCodes(incident),
            fingerprint = incident.fingerprint,
            artifacts = ReportArtifacts(
                sender = shareableSender(incident),
                senderType = incident.senderType,
                urls = of(ArtifactType.URL),
                domains = of(ArtifactType.DOMAIN),
                ibans = of(ArtifactType.IBAN),
                emails = of(ArtifactType.EMAIL),
                wallets = of(ArtifactType.WALLET),
                handles = of(ArtifactType.HANDLE),
                phones = of(ArtifactType.PHONE),
            ),
            language = incident.language,
            appVersion = appVersion,
            modelVersion = incident.modelVersion,
            synthetic = incident.synthetic,
            text = if (includeText) incident.text else null,
        )
    }

    override fun falsePositiveReport(incident: Incident, includeText: Boolean, appVersion: String, now: Long): FalsePositiveReport =
        FalsePositiveReport(
            reportId = falsePositiveReportId(incident),
            version = 1,
            createdAt = iso(now),
            fingerprint = incident.fingerprint,
            reasonCodes = reasonCodes(incident),
            senderType = incident.senderType,
            modelVersion = incident.modelVersion,
            userVerdict = incident.feedback,
            appVersion = appVersion,
            synthetic = incident.synthetic,
            text = if (includeText) incident.text else null,
        )

    override fun preview(report: ScamReport): ReportPreview = ReportPreview(
        json = toJson(report),
        included = ReportPreviewText.en(ReportPreviewLines.included(report)),
        excluded = ReportPreviewText.en(ReportPreviewLines.excluded(report)),
    )

    override fun preview(report: FalsePositiveReport): ReportPreview = ReportPreview(
        json = toJson(report),
        included = ReportPreviewText.en(ReportPreviewLines.included(report)),
        excluded = ReportPreviewText.en(ReportPreviewLines.excluded(report)),
    )

    override fun toJson(report: ScamReport): String = ReportJson.pretty.encodeToString(ScamReport.serializer(), report)

    override fun toJson(report: FalsePositiveReport): String =
        ReportJson.pretty.encodeToString(FalsePositiveReport.serializer(), report)

    /**
     * "Mirsad report mrs-…: suspected scam SMS from +440000000001, level HOLD, reasons: A, B. / تقرير مرصاد …"
     * Never includes the message text. Reason codes are trimmed until the whole line fits in [AMAN_MAX_CHARS].
     */
    override fun amanSummary(incident: Incident): String {
        val id = reportId(incident)
        val codes = reasonCodes(incident)
        val sender = shareableSender(incident)?.take(40)
        val senderEn = sender ?: "unknown sender"
        val senderAr = sender?.let { "‎$it‎" } ?: "مرسل غير معروف"
        val channelEn = when (incident.channel) { Channel.CALL -> "call"; Channel.SMS -> "SMS"; Channel.CHAT -> "chat message" }
        val channelAr = when (incident.channel) { Channel.CALL -> "مكالمة"; Channel.SMS -> "رسالة نصية"; Channel.CHAT -> "رسالة محادثة" }
        val levelAr = when (incident.level) { Level.ALLOW -> "مسموح"; Level.WARN -> "تحذير"; Level.HOLD -> "محجوز" }

        fun build(shown: Int, arabicCodes: Boolean): String {
            val head = codes.take(shown)
            val more = codes.size - head.size
            val list = (head + (if (more > 0) listOf("+$more") else emptyList())).joinToString(", ").ifEmpty { "none" }
            val en = "Mirsad report $id: suspected scam $channelEn from $senderEn, level ${incident.level}, reasons: $list."
            val ar = "تقرير مرصاد ‎$id‎: احتيال مشتبه عبر $channelAr من $senderAr، المستوى $levelAr" +
                if (arabicCodes) "، الأسباب: ‎$list‎." else "."
            return "$en / $ar"
        }

        var shown = codes.size
        var text = build(shown, true)
        while (text.length > AMAN_MAX_CHARS && shown > 1) { shown--; text = build(shown, true) }
        if (text.length > AMAN_MAX_CHARS) text = build(shown, false)
        if (text.length > AMAN_MAX_CHARS) text = build(0, false)
        return text.take(AMAN_MAX_CHARS)
    }

    companion object {
        const val AMAN_MAX_CHARS = 300

        /** "mrs-" + 12 hex chars from SHA-256(incident id, incident time, fingerprint): the same incident always gets the same id. */
        fun reportId(incident: Incident): String = "mrs-" + hex12("scam|${incident.id}|${incident.createdAt}|${incident.fingerprint}")

        /** Same inputs with a different salt, so a false-positive report never collides with the scam report of the same incident. */
        fun falsePositiveReportId(incident: Incident): String = "mrs-" + hex12("fp|${incident.id}|${incident.createdAt}|${incident.fingerprint}")

        /** ISO-8601 in UTC, e.g. `2026-11-24T20:15:00Z` (fraction only when the millis are not zero). */
        fun iso(epochMillis: Long): String = Instant.ofEpochMilli(epochMillis).toString()

        fun round3(value: Double): Double = Math.round(value * 1000.0) / 1000.0

        fun reasonCodes(incident: Incident): List<String> = incident.reasons.map { it.code }.distinct()

        /**
         * The sender as it may leave the phone: an E.164 number or an alphanumeric ID. A saved contact's display
         * name is personal data and stays on the phone (null). Unknown senders are null too.
         */
        fun shareableSender(incident: Incident): String? = when (incident.senderType) {
            SenderType.NUMBER -> incident.sender.trim().takeIf { it.isNotEmpty() }?.let { ArtifactNormaliser.phone(it) ?: it }
            SenderType.ALPHANUMERIC -> incident.sender.trim().takeIf { it.isNotEmpty() }
            SenderType.CONTACT, SenderType.UNKNOWN -> null
        }

        private fun hex12(input: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
            return digest.take(6).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }
    }
}
