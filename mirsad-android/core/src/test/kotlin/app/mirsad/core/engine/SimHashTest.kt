package app.mirsad.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SimHashTest {
    private val n = TextNormaliser()

    private fun fp(text: String) = SimHash.fingerprint(n.normalise(text))

    @Test
    fun `empty text gives the zero fingerprint and output is 16 lowercase hex`() {
        assertEquals(SimHash.ZERO, fp(""))
        assertEquals(SimHash.ZERO, SimHash.fingerprint("   "))
        val f = fp("Emirates Post: your parcel is held at customs.")
        assertEquals(16, f.length)
        assertTrue(f.all { it in '0'..'9' || it in 'a'..'f' }, f)
    }

    @Test
    fun `masks digits and urls`() {
        val tokens = SimHash.tokens(n.normalise("Pay AED 3.50 within 24 hours: http://emiratespost-ae.delivery-fee.example/pay or bank-update.example/ae"))
        assertEquals(listOf("pay", "aed", "#", "within", "#", "hours", "<url>", "or", "<url>"), tokens)
    }

    @Test
    fun `campaign variants are near and a legit message is far`() {
        val a = fp("Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours or it will be returned: http://emiratespost-ae.delivery-fee.example/pay")
        val b = fp("Emirates Post: your parcel is held at customs. Pay AED 12.75 within 48 hours or it will be returned: http://ep-customs.pay-now.example/x9")
        val c = fp("Your shipment 4521 is out for delivery today between 2 PM and 6 PM.")
        val d = fp("Emirates Post: your parcel is held at customs. Pay AED 5 within 24 hours or it will be sent back: http://other.example/pay")
        assertTrue(SimHash.hamming(a, b) <= 3, "variants differ by ${SimHash.hamming(a, b)} bits")
        assertTrue(SimHash.hamming(a, d) <= 12, "near-variants differ by ${SimHash.hamming(a, d)} bits")
        assertTrue(SimHash.hamming(a, c) >= 16, "legit message only ${SimHash.hamming(a, c)} bits away")
    }

    @Test
    fun `short texts still hash and arabic works`() {
        val a = fp("رمز التحقق الخاص بك هو 771204")
        val b = fp("رمز التحقق الخاص بك هو 118822")
        assertEquals(a, b)
        assertTrue(fp("hi") != SimHash.ZERO)
    }
}
