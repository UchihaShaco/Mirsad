package app.mirsad.core

import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Level
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ContractsSmokeTest {
    private val engine = MirsadEngineFactory.create()

    @Test
    fun `engine returns a verdict without throwing`() {
        val v = engine.analyse(
            Event(Channel.SMS, "+440000000001", "Pay AED 3.50 within 24 hours: http://emiratespost-ae.delivery-fee.example/pay", null, 0L, false),
        )
        assertTrue(v.score in 0.0..1.0)
        assertEquals(16, v.fingerprint.length)
    }

    @Test
    fun `a saved contact is never held`() {
        val v = engine.analyse(
            Event(Channel.CHAT, "Khalid", "Share your OTP now http://x.example/pay", "com.whatsapp", 0L, true),
        )
        assertTrue(v.level != Level.HOLD)
    }
}
