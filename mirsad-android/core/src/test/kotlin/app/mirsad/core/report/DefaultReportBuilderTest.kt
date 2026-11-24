package app.mirsad.core.report

import app.mirsad.core.contract.Artifact
import app.mirsad.core.contract.ArtifactType
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.FalsePositiveReport
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.Language
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.ScamReport
import app.mirsad.core.contract.SenderType
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DefaultReportBuilderTest {
    private val builder = DefaultReportBuilder()
    private val now = Instant.parse("2026-11-24T20:15:00Z").toEpochMilli()
    private val text = "Pay AED 3.50 within 24 hours: http://emiratespost-ae.delivery-fee.example/pay"

    private fun incident(
        sender: String = "+440000000001",
        senderType: SenderType = SenderType.NUMBER,
        text: String? = this.text,
        feedback: FeedbackVerdict = FeedbackVerdict.NONE,
        reasons: List<Reason> = listOf(
            Reason(ReasonCodes.LINK_LOOKALIKE_OFFICIAL, 0.6, "emiratespost-ae.delivery-fee.example", hard = true),
            Reason(ReasonCodes.CONTENT_SMALL_FEE_LINK, 0.4, null, hard = true),
            Reason(ReasonCodes.CONTENT_URGENCY, 0.2),
        ),
    ) = Incident(
        id = 7, createdAt = 1_764_000_000_000L, channel = Channel.SMS, sender = sender, senderType = senderType,
        appPackage = null, text = text, level = Level.HOLD, score = 0.912345, reasons = reasons,
        artifacts = listOf(
            Artifact(ArtifactType.URL, "http://emiratespost-ae.delivery-fee.example/pay"),
            Artifact(ArtifactType.URL, "http://x.example/y"),
            Artifact(ArtifactType.DOMAIN, "delivery-fee.example"),
            Artifact(ArtifactType.DOMAIN, "x.example"),
            Artifact(ArtifactType.PHONE, "+971500000003"),
        ),
        fingerprint = "0123456789abcdef", latencyMs = 12, language = Language.EN, modelVersion = "none",
        source = IncidentSource.DEMO, synthetic = true, feedback = feedback,
    )

    @Test
    fun `scam report round-trips through JSON`() {
        val report = builder.scamReport(incident(), includeText = true, appVersion = "0.1.0", now = now)
        val json = builder.toJson(report)
        val back = ReportJson.pretty.decodeFromString(ScamReport.serializer(), json)
        assertEquals(report, back)
        assertTrue(json.contains("\"version\": 1"), "defaults are written out")
    }

    @Test
    fun `report id is stable, well formed and differs for the false-positive report`() {
        val a = builder.scamReport(incident(), false, "0.1.0", now)
        val b = builder.scamReport(incident(), true, "0.2.0", now + 60_000)
        assertEquals(a.reportId, b.reportId)
        assertTrue(Regex("^mrs-[0-9a-f]{12}$").matches(a.reportId), a.reportId)
        val fp = builder.falsePositiveReport(incident(), false, "0.1.0", now)
        assertTrue(Regex("^mrs-[0-9a-f]{12}$").matches(fp.reportId), fp.reportId)
        assertNotEquals(a.reportId, fp.reportId)
        assertNotEquals(a.reportId, builder.scamReport(incident().copy(id = 8), false, "0.1.0", now).reportId)
    }

    @Test
    fun `text is absent unless ticked`() {
        val without = builder.scamReport(incident(), includeText = false, appVersion = "0.1.0", now = now)
        assertNull(without.text)
        assertFalse(builder.toJson(without).contains("Pay AED"))
        val with = builder.scamReport(incident(), includeText = true, appVersion = "0.1.0", now = now)
        assertEquals(text, with.text)
        assertTrue(builder.toJson(with).contains("Pay AED"))
    }

    @Test
    fun `contact sender is anonymised everywhere`() {
        val inc = incident(sender = "Khalid", senderType = SenderType.CONTACT)
        val report = builder.scamReport(inc, includeText = false, appVersion = "0.1.0", now = now)
        assertNull(report.artifacts.sender)
        assertEquals(SenderType.CONTACT, report.artifacts.senderType)
        assertFalse(builder.toJson(report).contains("Khalid"))
        assertFalse(builder.amanSummary(inc).contains("Khalid"))
        assertTrue(builder.preview(report).excluded.contains("The sender's name"))
        assertTrue(builder.preview(report).included.contains("That the sender is a saved contact (the name is withheld)"))
    }

    @Test
    fun `artifacts are grouped by type, sender normalised, score rounded, time in ISO UTC`() {
        val report = builder.scamReport(incident(sender = "00 44 0000 000001"), false, "0.1.0", now)
        assertEquals(listOf("http://emiratespost-ae.delivery-fee.example/pay", "http://x.example/y"), report.artifacts.urls)
        assertEquals(listOf("delivery-fee.example", "x.example"), report.artifacts.domains)
        assertEquals(listOf("+971500000003"), report.artifacts.phones)
        assertTrue(report.artifacts.ibans.isEmpty())
        assertEquals("+440000000001", report.artifacts.sender)
        assertEquals(0.912, report.score)
        assertEquals("2026-11-24T20:15:00Z", report.createdAt)
        assertEquals(listOf(ReasonCodes.LINK_LOOKALIKE_OFFICIAL, ReasonCodes.CONTENT_SMALL_FEE_LINK, ReasonCodes.CONTENT_URGENCY), report.reasonCodes)
        assertEquals("ADCB", builder.scamReport(incident(sender = "ADCB", senderType = SenderType.ALPHANUMERIC), false, "0.1.0", now).artifacts.sender)
    }

    @Test
    fun `preview lists what is in and what is never in the JSON`() {
        val report = builder.scamReport(incident(), includeText = false, appVersion = "0.1.0", now = now)
        val preview = builder.preview(report)
        assertEquals(builder.toJson(report), preview.json)
        listOf(
            "Sender number +4400…",
            "2 links and their domains",
            "1 phone number mentioned in the message",
            "Verdict, score and reason codes",
            "Message fingerprint (a hash, not the text)",
            "Channel (call, SMS or chat) and detected language",
            "Mirsad version and model version",
            "A flag that this is synthetic demo data",
        ).forEach { assertTrue(preview.included.contains(it), "included should list: $it, got ${preview.included}") }
        assertFalse(preview.included.contains("The message text"))
        listOf(
            "Your contacts", "Other messages", "Your location", "Device identifiers (IMEI, Android ID)",
            "Your own phone number", "The message text",
        ).forEach { assertTrue(preview.excluded.contains(it), "excluded should list: $it") }

        val withText = builder.preview(builder.scamReport(incident(), includeText = true, appVersion = "0.1.0", now = now))
        assertTrue(withText.included.contains("The message text"))
        assertFalse(withText.excluded.contains("The message text"))
    }

    @Test
    fun `arabic preview mirrors the english one line for line`() {
        val report = builder.scamReport(incident(), includeText = false, appVersion = "0.1.0", now = now)
        val en = builder.preview(report)
        val ar = ReportPreviewText.ar(report)
        assertEquals(en.included.size, ar.included.size)
        assertEquals(en.excluded.size, ar.excluded.size)
        assertEquals(en.json, ar.json)
        assertTrue(ar.excluded.contains("نص الرسالة"))
        assertTrue(ar.included.any { it.startsWith("رقم المرسل") })
    }

    @Test
    fun `false-positive report carries the verdict and no sender`() {
        val inc = incident(feedback = FeedbackVerdict.FALSE_POSITIVE)
        val report = builder.falsePositiveReport(inc, includeText = false, appVersion = "0.1.0", now = now)
        assertEquals(FeedbackVerdict.FALSE_POSITIVE, report.userVerdict)
        assertEquals(SenderType.NUMBER, report.senderType)
        assertNull(report.text)
        val json = builder.toJson(report)
        assertFalse(json.contains("+440000000001"))
        assertFalse(json.contains("Pay AED"))
        assertEquals(report, ReportJson.pretty.decodeFromString(FalsePositiveReport.serializer(), json))
        val preview = builder.preview(report)
        assertTrue(preview.excluded.contains("The sender's number or name"))
        assertTrue(preview.excluded.contains("The message text"))
        assertTrue(preview.included.contains("Your verdict (not a scam) and the reason codes Mirsad used"))
        assertEquals(text, builder.falsePositiveReport(inc, includeText = true, appVersion = "0.1.0", now = now).text)
        assertEquals(preview.included.size, ReportPreviewText.ar(report).included.size)
    }

    @Test
    fun `aman summary is short, bilingual and never carries the text`() {
        val inc = incident()
        val summary = builder.amanSummary(inc)
        assertTrue(summary.length <= 300, "length ${summary.length}: $summary")
        assertTrue(summary.contains(DefaultReportBuilder.reportId(inc)))
        assertTrue(summary.contains("+440000000001"))
        assertTrue(summary.contains("HOLD"))
        assertTrue(summary.contains(ReasonCodes.LINK_LOOKALIKE_OFFICIAL))
        assertTrue(summary.contains("تقرير مرصاد"))
        assertFalse(summary.contains("Pay AED"))
        assertFalse(summary.contains("delivery-fee"))

        val many = incident(reasons = ReasonCodes::class.java.declaredFields
            .filter { it.type == String::class.java }
            .map { Reason(it.get(null) as String, 0.1) })
        val long = builder.amanSummary(many)
        assertTrue(long.length <= 300, "length ${long.length}: $long")
        assertTrue(long.contains("Mirsad report"))

        val unknown = builder.amanSummary(incident(sender = "", senderType = SenderType.UNKNOWN))
        assertTrue(unknown.contains("unknown sender"))
        assertTrue(unknown.contains("مرسل غير معروف"))
    }
}
