package app.mirsad.core.report

import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.ScamReport
import app.mirsad.core.contract.SenderType
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// The request body of the root Mirsad product's `POST /v1/ingest` (openapi.yaml: IngestRequest, IntakeEvent
// `message.recorded`, Source, Direction). Optional fields are omitted when null; the schema does not accept nulls.

@Serializable
data class IngestRequest(
    val source: String,
    val externalAccountId: String,
    val externalChatId: String,
    val chat: IngestChat? = null,
    val event: IngestEvent,
)

@Serializable
data class IngestChat(val displayLabel: String)

@Serializable
data class IngestEvent(
    val type: String = "message.recorded",
    val sourceEventId: String,
    val sourceMessageId: String,
    val direction: String = "incoming",
    val text: String,
    val sentAt: String? = null,
    val sender: IngestSender? = null,
)

@Serializable
data class IngestSender(
    val externalId: String,
    val displayName: String? = null,
    val phone: IngestPhone? = null,
)

@Serializable
data class IngestPhone(
    val raw: String,
    val country: String? = null,
    val internationalFormat: Boolean? = null,
)

/**
 * Maps a [ScamReport] to the root Mirsad product's ingest body. Used by the laptop-side script
 * (scripts/push_report_to_mirsad.sh reproduces this mapping in jq/python) and documented in docs/EVIDENCE_SCHEMA.md.
 *
 * Limits of the schema, documented rather than hidden:
 * - `Source` is only `telegram` | `whatsapp`; SMS and calls have no value. WhatsApp and Telegram captures map
 *   exactly, everything else uses [fallbackSource] (default telegram, because the product's WhatsApp intake is
 *   gated off by default and answers 422 channel_not_enabled). The real channel is in the event text.
 * - the capture method is not in the body: it is fixed on the connector token when it is provisioned.
 *   Provision the connector with `approved_import` (an imported, officer-supplied capture), never a live method.
 * - the incident time is not part of the report v1, so callers pass it; the script uses report.createdAt.
 */
object MirsadIngestMapper {
    const val SOURCE_TELEGRAM = "telegram"
    const val SOURCE_WHATSAPP = "whatsapp"
    const val EXTERNAL_ACCOUNT_PREFIX = "mirsad-android:"

    private const val MAX_ID = 200
    private const val MAX_LABEL = 200
    private const val MAX_TEXT = 65_536
    private const val MAX_PHONE = 64

    val json: Json = Json { prettyPrint = true; encodeDefaults = true; explicitNulls = false }

    fun map(report: ScamReport, incident: Incident, fallbackSource: String = SOURCE_TELEGRAM): IngestRequest =
        map(report, sentAtEpochMillis = incident.createdAt, appPackage = incident.appPackage, fallbackSource = fallbackSource)

    fun map(
        report: ScamReport,
        sentAtEpochMillis: Long? = null,
        appPackage: String? = null,
        fallbackSource: String = SOURCE_TELEGRAM,
    ): IngestRequest {
        val sender = report.artifacts.sender?.trim()?.takeIf { it.isNotEmpty() }
        val chatId = sender ?: report.fingerprint
        return IngestRequest(
            source = source(appPackage, fallbackSource),
            externalAccountId = (EXTERNAL_ACCOUNT_PREFIX + report.reportId).take(MAX_ID),
            externalChatId = chatId.take(MAX_ID),
            chat = IngestChat(displayLabel = "Mirsad Android report ${report.reportId}".take(MAX_LABEL)),
            event = IngestEvent(
                type = "message.recorded",
                sourceEventId = report.reportId.take(MAX_ID),
                sourceMessageId = report.reportId.take(MAX_ID),
                direction = "incoming",
                text = (report.text ?: summaryText(report)).take(MAX_TEXT),
                sentAt = sentAtEpochMillis?.let { DefaultReportBuilder.iso(it) } ?: report.createdAt,
                sender = IngestSender(
                    externalId = chatId.take(MAX_ID),
                    displayName = if (report.artifacts.senderType == SenderType.ALPHANUMERIC) sender?.take(MAX_LABEL) else null,
                    phone = if (report.artifacts.senderType == SenderType.NUMBER && sender != null) IngestPhone(
                        raw = sender.take(MAX_PHONE),
                        country = if (sender.startsWith("+971")) "AE" else null,
                        internationalFormat = sender.startsWith("+"),
                    ) else null,
                ),
            ),
        )
    }

    fun toJson(request: IngestRequest): String = json.encodeToString(IngestRequest.serializer(), request)

    /** `telegram` / `whatsapp` for those apps, [fallback] for everything else (SMS, calls, other chat apps, shares). */
    fun source(appPackage: String?, fallback: String = SOURCE_TELEGRAM): String = when (appPackage) {
        DefaultPackages.TELEGRAM -> SOURCE_TELEGRAM
        DefaultPackages.WHATSAPP, DefaultPackages.WHATSAPP_BUSINESS -> SOURCE_WHATSAPP
        else -> fallback
    }

    /** One line that stands in for the text when the user did not share it. Same format in the shell script. */
    fun summaryText(report: ScamReport): String {
        val codes = report.reasonCodes.joinToString(", ").ifEmpty { "none" }
        return "Mirsad Android report ${report.reportId}: suspected scam, channel ${report.channel}, level ${report.level}, " +
            "score ${report.score}, reasons: $codes. Message text withheld by the user."
    }
}
