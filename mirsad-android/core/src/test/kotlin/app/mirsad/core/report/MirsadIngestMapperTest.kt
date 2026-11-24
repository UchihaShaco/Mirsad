package app.mirsad.core.report

import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.Language
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.ReportArtifacts
import app.mirsad.core.contract.ScamReport
import app.mirsad.core.contract.SenderType
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MirsadIngestMapperTest {
    private val now = 1_764_000_000_000L

    /** The date-time pattern of IntakeEvent.sentAt in openapi.yaml, reduced to its shape. */
    private val dateTime = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$")

    private fun report(
        sender: String? = "+440000000001",
        senderType: SenderType = SenderType.NUMBER,
        text: String? = null,
    ) = ScamReport(
        reportId = "mrs-0123456789ab", createdAt = "2026-11-24T20:15:00Z", channel = Channel.SMS, level = Level.HOLD,
        score = 0.912, reasonCodes = listOf(ReasonCodes.LINK_LOOKALIKE_OFFICIAL, ReasonCodes.CONTENT_SMALL_FEE_LINK),
        fingerprint = "0123456789abcdef",
        artifacts = ReportArtifacts(sender = sender, senderType = senderType, urls = listOf("http://x.example/y"), domains = listOf("x.example")),
        language = Language.EN, appVersion = "0.1.0", modelVersion = "none", synthetic = true, text = text,
    )

    private fun parse(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    /** Hand-check of the required keys of IngestRequest and the `message.recorded` IntakeEvent. */
    private fun assertRequiredKeys(body: JsonObject) {
        listOf("source", "externalAccountId", "externalChatId", "event").forEach { assertTrue(it in body, "IngestRequest.$it") }
        val event = body["event"]!!.jsonObject
        listOf("type", "sourceEventId", "sourceMessageId", "direction", "text").forEach { assertTrue(it in event, "IntakeEvent.$it") }
        assertEquals("message.recorded", event["type"]!!.jsonPrimitive.content)
        assertEquals("incoming", event["direction"]!!.jsonPrimitive.content)
        assertTrue(body["source"]!!.jsonPrimitive.content in setOf("telegram", "whatsapp"))
        event["sentAt"]?.let { assertTrue(dateTime.matches(it.jsonPrimitive.content), it.toString()) }
        event["sender"]?.jsonObject?.let { sender ->
            assertTrue("externalId" in sender, "sender.externalId")
            sender["phone"]?.jsonObject?.let { assertTrue("raw" in it, "phone.raw") }
        }
    }

    @Test
    fun `maps a number sender to the ingest body with every required field`() {
        val request = MirsadIngestMapper.map(report(), sentAtEpochMillis = now, appPackage = null)
        val json = MirsadIngestMapper.toJson(request)
        val body = parse(json)
        assertRequiredKeys(body)
        assertFalse(json.contains("null"), "optional fields are omitted, never null: $json")
        assertEquals("telegram", body["source"]!!.jsonPrimitive.content)
        assertEquals("mirsad-android:mrs-0123456789ab", body["externalAccountId"]!!.jsonPrimitive.content)
        assertEquals("+440000000001", body["externalChatId"]!!.jsonPrimitive.content)
        assertEquals("Mirsad Android report mrs-0123456789ab", body["chat"]!!.jsonObject["displayLabel"]!!.jsonPrimitive.content)
        val event = body["event"]!!.jsonObject
        assertEquals("mrs-0123456789ab", event["sourceEventId"]!!.jsonPrimitive.content)
        assertEquals("mrs-0123456789ab", event["sourceMessageId"]!!.jsonPrimitive.content)
        assertEquals(DefaultReportBuilder.iso(now), event["sentAt"]!!.jsonPrimitive.content)
        val sender = event["sender"]!!.jsonObject
        assertEquals("+440000000001", sender["externalId"]!!.jsonPrimitive.content)
        assertNull(sender["displayName"])
        val phone = sender["phone"]!!.jsonObject
        assertEquals("+440000000001", phone["raw"]!!.jsonPrimitive.content)
        assertTrue(phone["internationalFormat"]!!.jsonPrimitive.boolean)
        assertNull(phone["country"], "country only for +971")
        val text = event["text"]!!.jsonPrimitive.content
        assertTrue(text.contains(ReasonCodes.LINK_LOOKALIKE_OFFICIAL) && text.contains("withheld"), text)
        assertFalse(text.contains("\n"))
    }

    @Test
    fun `uses the message text when the user shared it and AE for UAE numbers`() {
        val request = MirsadIngestMapper.map(report(sender = "+971500000003", text = "Pay now http://x.example/y"), now, DefaultPackages.WHATSAPP)
        assertEquals("Pay now http://x.example/y", request.event.text)
        assertEquals("whatsapp", request.source)
        assertEquals("AE", request.event.sender?.phone?.country)
        assertRequiredKeys(parse(MirsadIngestMapper.toJson(request)))
    }

    @Test
    fun `alphanumeric and contact senders`() {
        val alnum = MirsadIngestMapper.map(report(sender = "ADCB", senderType = SenderType.ALPHANUMERIC), now, DefaultPackages.TELEGRAM)
        assertEquals("ADCB", alnum.externalChatId)
        assertEquals("ADCB", alnum.event.sender?.displayName)
        assertNull(alnum.event.sender?.phone)
        assertEquals("telegram", alnum.source)

        val contact = MirsadIngestMapper.map(report(sender = null, senderType = SenderType.CONTACT), now, "im.thebot.messenger")
        assertEquals("0123456789abcdef", contact.externalChatId)
        assertEquals("0123456789abcdef", contact.event.sender?.externalId)
        assertNull(contact.event.sender?.displayName)
        assertNull(contact.event.sender?.phone)
        assertRequiredKeys(parse(MirsadIngestMapper.toJson(contact)))
    }

    @Test
    fun `source falls back for channels the schema has no value for`() {
        assertEquals("telegram", MirsadIngestMapper.source(null))
        assertEquals("whatsapp", MirsadIngestMapper.source(null, fallback = "whatsapp"))
        assertEquals("whatsapp", MirsadIngestMapper.source(DefaultPackages.WHATSAPP_BUSINESS))
        assertEquals("telegram", MirsadIngestMapper.source("com.google.android.apps.messaging"))
        val r = MirsadIngestMapper.map(report(), sentAtEpochMillis = null)
        assertEquals("2026-11-24T20:15:00Z", r.event.sentAt, "report time when the incident time is unknown")
    }

    @Test
    fun `the sample report used by the push script maps cleanly`() {
        val sample = File("../scripts/sample_report.json")
        if (!sample.isFile) return
        val report = ReportJson.pretty.decodeFromString(ScamReport.serializer(), sample.readText())
        assertTrue(report.synthetic, "the sample must be marked synthetic")
        val json = MirsadIngestMapper.toJson(MirsadIngestMapper.map(report))
        val body = parse(json)
        assertRequiredKeys(body)
        assertEquals("mirsad-android:${report.reportId}", body["externalAccountId"]!!.jsonPrimitive.content)
        // The same line the shell script (jq / python) builds for this sample; keep the three in step.
        assertEquals(
            "Mirsad Android report mrs-5a1f3c9e7b2d: suspected scam, channel SMS, level HOLD, score 0.912, reasons: " +
                "LINK_LOOKALIKE_OFFICIAL, CONTENT_SMALL_FEE_LINK, CONTENT_URGENCY. Message text withheld by the user.",
            body["event"]!!.jsonObject["text"]!!.jsonPrimitive.content,
        )
        assertEquals(setOf("source", "externalAccountId", "externalChatId", "chat", "event"), body.keys)
        assertEquals(setOf("type", "sourceEventId", "sourceMessageId", "direction", "text", "sentAt", "sender"), body["event"]!!.jsonObject.keys)
        // Written so the script's dry run can be diffed against the Kotlin mapper: core/build/reports/sample_ingest_body.json
        File("build/reports").mkdirs()
        File("build/reports/sample_ingest_body.json").writeText(json)
    }
}
