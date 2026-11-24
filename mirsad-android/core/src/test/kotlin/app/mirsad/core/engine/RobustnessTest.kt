package app.mirsad.core.engine

import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Level
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** Regressions from the independent verification: backtracking, fail-open errors, never-HOLD one-time codes. */
class RobustnessTest {
    private val engine = MirsadEngineFactory.create()
    private val now = 1_700_000_000_000L

    private fun sms(sender: String, text: String) = Event(Channel.SMS, sender, text, null, now, false)

    @Test
    fun `every rule pattern compiles`() {
        RuleSet.loadFromResources()
        assertTrue(RuleSet.rejectedPatterns.isEmpty(), "rejected: ${RuleSet.rejectedPatterns}")
    }

    @Test
    fun `pathological inputs stay fast`() {
        engine.analyse(sms("+971500000001", "warm up http://x.example"))
        val inputs = listOf(
            "ha-".repeat(800), "a".repeat(50_000) + "!", "1".repeat(5_000), "a-".repeat(2_500),
            ("x".repeat(20) + "@").repeat(200), "a.".repeat(4_000), "send" + " me".repeat(4_000), "á".repeat(3_000),
        )
        for (text in inputs) {
            val t0 = System.nanoTime()
            engine.analyse(sms("+971500000001", text))
            val ms = (System.nanoTime() - t0) / 1_000_000
            assertTrue(ms < 2_000, "${text.take(12)}… took $ms ms")
        }
    }

    @Test
    fun `padding cannot turn a held scam into ALLOW`() {
        val scam = "Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours: http://emiratespost-ae.delivery-fee.example/pay "
        for (pad in listOf("www.".repeat(1_500), "a.".repeat(4_000), "1.".repeat(4_000), " me".repeat(4_000))) {
            val v = engine.analyse(sms("+447000000001", scam + pad))
            assertNotEquals(Level.ALLOW, v.level, "padding ${pad.take(6)}: ${v.reasons.map { it.code }}")
        }
        assertEquals(Level.HOLD, engine.analyse(sms("+447000000001", scam + "www.".repeat(1_500))).level)
    }

    private fun rows(name: String): List<List<String>> {
        val f = listOf(File("../data/$name"), File("data/$name")).first { it.exists() }
        return f.readLines(Charsets.UTF_8).filter { it.isNotBlank() && !it.startsWith("#") }.map { it.split('\t', limit = 3) }
    }

    @Test
    fun `one-time codes from sender IDs and fraud-awareness texts are never held`() {
        for (file in listOf("never_hold_otp.tsv", "never_hold_negation.tsv")) {
            val held = rows(file).filter { (ch, sender, text) ->
                val contact = sender.any { it.isLowerCase() } && sender.none { it.isDigit() } && ch == "CHAT"
                engine.analyse(Event(Channel.valueOf(ch), sender, text, null, now, contact)).level == Level.HOLD
            }
            assertTrue(held.isEmpty(), "$file held ${held.size}: ${held.map { it[2].take(60) }}")
        }
    }
}
