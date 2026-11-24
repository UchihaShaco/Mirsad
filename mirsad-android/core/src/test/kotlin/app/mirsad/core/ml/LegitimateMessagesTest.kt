package app.mirsad.core.ml

import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Level
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Build gate: every row of data/legit_suite.csv goes through the real engine. None may be HELD and at most two
 * may be WARNED. Failing rows are printed with their reason codes so the engine owner can see what fired.
 */
class LegitimateMessagesTest {
    private val engine = MirsadEngineFactory.create()

    @Test
    fun `legitimate uae messages are never held and at most two are warned`() {
        val rows = TestData.legitSuite
        assertTrue(rows.size >= 40, "legit suite has only ${rows.size} rows")
        val now = System.currentTimeMillis()
        val flagged = ArrayList<String>()
        var holds = 0
        var warns = 0
        for (row in rows) {
            val channel = Channel.valueOf(row.channel)
            val event = Event(
                channel = channel,
                sender = row.sender,
                text = row.text,
                appPackage = null,
                timestamp = now,
                senderLooksLikeContact = looksLikePersonName(row.sender, channel),
            )
            val verdict = engine.analyse(event)
            if (verdict.level != Level.ALLOW) {
                if (verdict.level == Level.HOLD) holds++ else warns++
                val codes = verdict.reasons.joinToString(", ") { r ->
                    r.code + (if (r.hard) "!" else "") + "(%.2f)".format(r.weight) + (r.detail?.let { " $it" } ?: "")
                }
                flagged += "%s score=%.2f [%s] %s | %s".format(verdict.level, verdict.score, row.sender, row.text, codes)
            }
        }
        println("legit suite: ${rows.size} rows, $holds HOLD, $warns WARN (engine rules=${engine.analyse(Event(Channel.SMS, "x", "x", null, now, false)).rulesVersion})")
        flagged.forEach { println("  $it") }
        assertEquals(0, holds, "legitimate rows were HELD:\n" + flagged.joinToString("\n"))
        assertTrue(warns <= 2, "more than two legitimate rows were WARNED ($warns):\n" + flagged.joinToString("\n"))
    }

    /** A chat sender that is not a phone number is a display name, i.e. parsed as a saved contact. */
    private fun looksLikePersonName(sender: String, channel: Channel): Boolean =
        channel == Channel.CHAT && !PHONE.matches(sender.trim())

    private companion object {
        val PHONE = Regex("""\+?[0-9][0-9 \-]{5,}""")
    }
}
