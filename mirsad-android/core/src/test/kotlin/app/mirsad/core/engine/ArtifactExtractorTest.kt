package app.mirsad.core.engine

import app.mirsad.core.contract.Artifact
import app.mirsad.core.contract.ArtifactType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ArtifactExtractorTest {
    private val rules = RuleSet.loadFromResources()
    private val normaliser = TextNormaliser(rules.arabizi)
    private val links = LinkAnalyser(rules, Lexicon.loadFromResources(normaliser))
    private val extractor = ArtifactExtractor()

    private fun extract(text: String): List<Artifact> {
        val norm = normaliser.normalise(text)
        return extractor.extract(text, norm, links.extract(norm))
    }

    @Test
    fun `phone numbers become e164 with default region ae`() {
        assertEquals("+971500000003", PhoneNumbers.toE164("0500000003"))
        assertEquals("+971500000003", PhoneNumbers.toE164("050 000 0003"))
        assertEquals("+971500000003", PhoneNumbers.toE164("+971 50 000 0003"))
        assertEquals("+971500000003", PhoneNumbers.toE164("00971500000003"))
        assertEquals("+971500000003", PhoneNumbers.toE164("971500000003"))
        assertEquals("+971500000003", PhoneNumbers.toE164("+9710500000003"))
        assertEquals("+97120000000", PhoneNumbers.toE164("02 000 0000"))
        assertEquals("+97140000000", PhoneNumbers.toE164("040000000"))
        assertEquals("+440000000001", PhoneNumbers.toE164("+44 0000 000001"))
        assertEquals("8001234", PhoneNumbers.toE164("800 1234"))
        assertEquals("600123456", PhoneNumbers.toE164("600123456"))
        assertNull(PhoneNumbers.toE164("482913"))
        assertNull(PhoneNumbers.toE164("0000000000"))
        assertNull(PhoneNumbers.toE164("ADCB"))
        assertTrue(PhoneNumbers.isUae("+971500000003"))
        assertTrue(PhoneNumbers.isUae("8001234"))
        assertFalse(PhoneNumbers.isUae("+440000000001"))
    }

    @Test
    fun `iban ae passes mod 97 and other countries are syntactic`() {
        assertTrue(Iban.mod97("AE070331234567890123456"))
        assertEquals("AE070331234567890123456", Iban.normalise("AE07 0331 2345 6789 0123 456"))
        assertNull(Iban.normalise("AE070331234567890123457"), "wrong check digits must fail for AE")
        assertEquals("GB29NWBK60161331926819", Iban.normalise("GB29 NWBK 6016 1331 9268 19"))
        assertEquals("SA0380000000608010167519", Iban.normalise("SA03 8000 0000 6080 1016 7519 please"))
        assertNull(Iban.normalise("ZZ07033123456789012345"))
    }

    @Test
    fun `extracts every artifact type and dedupes`() {
        val text = "Send AED 2,000 to IBAN AE070331234567890123456 or AE07 0331 2345 6789 0123 456 today. " +
            "Call 050 000 0003 or +971500000003, mail help@pay-now.example, " +
            "BTC 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2, ETH 0x52908400098527886E0F7030069857D2E4169EE7, " +
            "TRON TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7, chat wa.me/0000000000 or t.me/hr_uae_jobs_example " +
            "and http://bank-update.example/ae"
        val artifacts = extract(text)
        val byType = artifacts.groupBy({ it.type }, { it.value })
        assertEquals(listOf("AE070331234567890123456"), byType[ArtifactType.IBAN])
        assertEquals(listOf("+971500000003"), byType[ArtifactType.PHONE])
        assertEquals(listOf("help@pay-now.example"), byType[ArtifactType.EMAIL])
        assertEquals(
            listOf("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "0x52908400098527886E0F7030069857D2E4169EE7", "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"),
            byType[ArtifactType.WALLET],
        )
        assertEquals(listOf("wa.me/0000000000", "t.me/hr_uae_jobs_example"), byType[ArtifactType.HANDLE])
        assertEquals(listOf("http://bank-update.example/ae"), byType[ArtifactType.URL])
        assertEquals(listOf("bank-update.example"), byType[ArtifactType.DOMAIN])
        assertEquals(artifacts.size, artifacts.toSet().size, "artifacts are deduplicated")
    }

    @Test
    fun `otp codes and amounts are not phone numbers`() {
        val artifacts = extract("Your OTP is 482913 for a purchase of AED 120.00 at CARREFOUR. Shipment 0000000042 is out for delivery.")
        assertTrue(artifacts.none { it.type == ArtifactType.PHONE }, "unexpected: $artifacts")
    }
}
