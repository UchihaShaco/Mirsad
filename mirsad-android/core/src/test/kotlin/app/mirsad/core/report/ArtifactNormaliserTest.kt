package app.mirsad.core.report

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ArtifactNormaliserTest {

    @Test
    fun `phone numbers become E164 with UAE as the default country`() {
        assertEquals("+971501234567", ArtifactNormaliser.phone("0501234567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("050 123 4567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("050-123-4567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("501234567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("971501234567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("+971 (50) 123 4567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("00971501234567"))
        assertEquals("+971501234567", ArtifactNormaliser.phone("٠٥٠١٢٣٤٥٦٧"))
        assertEquals("+440000000001", ArtifactNormaliser.phone("+44 0000 000001"))
        assertEquals("+440000000001", ArtifactNormaliser.phone("0044 0000 000001"))
        assertEquals("+440000000001", ArtifactNormaliser.phone("440000000001"))
        assertEquals("+966500000001", ArtifactNormaliser.phone("0500000001", defaultCountryCode = "966"))
        assertNull(ArtifactNormaliser.phone("ADCB"))
        assertNull(ArtifactNormaliser.phone("2828"))
        assertNull(ArtifactNormaliser.phone("+0 123 456 789"))
        assertNull(ArtifactNormaliser.phone(""))
        assertNull(ArtifactNormaliser.phone("+1234567890123456"))
        assertNull(ArtifactNormaliser.phone("+44 0000 x1"))
    }

    @Test
    fun `domains become lowercase registrable domains`() {
        assertEquals("delivery-fee.example", ArtifactNormaliser.domain("Delivery-Fee.EXAMPLE"))
        assertEquals("delivery-fee.example", ArtifactNormaliser.domain("https://pay.delivery-fee.example/path?q=1#f"))
        assertEquals("delivery-fee.example", ArtifactNormaliser.domain("http://user:pw@www.delivery-fee.example:8080/"))
        assertEquals("delivery-fee.example", ArtifactNormaliser.domain("www.delivery-fee.example."))
        assertEquals("bank-update.co.ae", ArtifactNormaliser.domain("login.bank-update.co.ae"))
        assertEquals("b.co.uk", ArtifactNormaliser.domain("a.b.co.uk"))
        assertEquals("co.ae", ArtifactNormaliser.domain("co.ae"))
        val idn = assertNotNull(ArtifactNormaliser.domain("مثال.example"))
        assertTrue(idn.startsWith("xn--") && idn.endsWith(".example"), idn)
        assertNull(ArtifactNormaliser.domain("192.168.0.1"))
        assertNull(ArtifactNormaliser.domain("localhost"))
        assertNull(ArtifactNormaliser.domain("not a domain"))
        assertNull(ArtifactNormaliser.domain("-bad.example"))
        assertNull(ArtifactNormaliser.domain(""))
    }

    @Test
    fun `fingerprints are 16 lowercase hex chars`() {
        assertEquals("0123456789abcdef", ArtifactNormaliser.fingerprint(" 0123456789ABCDEF "))
        assertEquals("0123456789abcdef", ArtifactNormaliser.fingerprint("0x0123456789abcdef"))
        assertNull(ArtifactNormaliser.fingerprint("0123456789abcde"))
        assertNull(ArtifactNormaliser.fingerprint("0123456789abcdefg"))
        assertNull(ArtifactNormaliser.fingerprint("zzzzzzzzzzzzzzzz"))
    }
}
