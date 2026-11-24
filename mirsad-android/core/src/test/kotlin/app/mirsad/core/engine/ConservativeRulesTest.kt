package app.mirsad.core.engine

import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Language
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ReasonCodes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stage 1 alone (no classifier). Legit UAE patterns that look "scam-adjacent" must stay ALLOW (one WARN tolerated
 * for the shortener + deadline case); scam shapes not in the seed rows must still be caught.
 */
class ConservativeRulesTest {
    private val engine = MirsadEngine.create()
    private val ctx = EngineContext(stageOneOnly = true)

    private fun sms(sender: String, text: String) = engine.analyse(Event(Channel.SMS, sender, text, null, 0L, false), ctx)
    private fun chat(sender: String, text: String, contact: Boolean = false) =
        engine.analyse(Event(Channel.CHAT, sender, text, "com.whatsapp", 0L, contact), ctx)
    private fun codes(v: app.mirsad.core.contract.Verdict) = v.reasons.joinToString { it.code + (if (it.hard) "!" else "") }

    @Test
    fun `official link amount app name and due date alone are not a scam`() {
        val rows = listOf(
            sms("ADCB", "ADCB: AED 1,250.00 is due on your credit card by 5 Dec. Pay in the ADCB app or at https://www.adcb.com/pay"),
            sms("Etisalat", "Your bill of AED 199 is overdue. Please pay in the e& app to avoid disconnection on 30 Nov."),
            sms("FAB", "FAB: did you make a transaction of AED 2,300.00 at an online merchant? Reply YES or NO. If not, call 600 525500."),
            sms("ENBD", "Emirates NBD: we noticed a suspicious login attempt. If this was not you, call us on 600 540000 immediately."),
            sms("Aramex", "Aramex: your shipment has a customs duty of AED 120.00. Pay at https://www.aramex.com/pay before delivery."),
            sms("Careem", "Chat with our support team on WhatsApp: wa.me/9710000000000 (business account)."),
            sms("DEWA", "DEWA: your payment of AED 25.00 for green charger was received. Thank you."),
            sms("Salik", "Salik: toll AED 4 deducted at Al Garhoud. Balance AED 38. Top up in the Salik app."),
            chat("+971500000040", "Hello, this is Ahmed from Al Futtaim. Your car service is complete, total AED 850, pay at the counter."),
            chat("+971500000041", "Did you pay the DEWA bill? I think it's due tomorrow, 412 dirhams."),
            chat("Noora", "yalla nel2a 3al 6 fel corniche? el jaw 7elo el yom.", contact = true),
        )
        val flagged = rows.filter { it.level != Level.ALLOW }.map { "${it.level} %.2f ${codes(it)}".format(it.score) }
        assertTrue(flagged.isEmpty(), flagged.joinToString("\n"))
        assertEquals(Language.LATIN_ARABIC, rows.last().language)
    }

    @Test
    fun `marketing with a shortener and a deadline is at most warn`() {
        val v = sms("NOON", "Yellow Friday ends today. Up to 70% off: bit.ly/noon-yf. T&Cs apply.")
        assertTrue(v.level != Level.HOLD, codes(v))
        assertTrue(v.reasons.any { it.code == ReasonCodes.LINK_SHORTENER })
    }

    @Test
    fun `lookalike official domain is held even from an alphanumeric sender`() {
        val v = sms("ADCB", "ADCB: your card is temporarily blocked. Verify at https://adcb.co/verify")
        assertEquals(Level.HOLD, v.level, codes(v))
        assertTrue(v.reasons.any { it.code == ReasonCodes.LINK_LOOKALIKE_OFFICIAL && it.hard })
    }

    @Test
    fun `blocklisted domain and blocklisted sender are hard`() {
        val v = sms("+971500000042", "Your parcel: see https://track.bad.example/x", )
        val held = engine.analyse(Event(Channel.SMS, "+971500000042", "Your parcel: see https://track.bad.example/x", null, 0L, false), ctx.copy(blockedDomains = setOf("bad.example")))
        assertTrue(v.level != Level.HOLD)
        assertEquals(Level.HOLD, held.level, codes(held))
        val blockedSender = engine.analyse(Event(Channel.SMS, "0500000043", "hi", null, 0L, false), ctx.copy(blockedSenders = setOf("+971500000043")))
        assertEquals(Level.HOLD, blockedSender.level)
    }

    @Test
    fun `arabizi and arabic scam shapes are caught`() {
        val arabizi = chat("+971500000044", "mabrouk! rbe7t jayza 5000 dirham mn etisalat. ab3at ramz el ta7aqoq w ra8am el bita8a 3ashan tst3ml el jayza")
        assertTrue(arabizi.level != Level.ALLOW, codes(arabizi))
        assertEquals(Language.LATIN_ARABIC, arabizi.language)
        assertTrue(arabizi.reasons.any { it.code == ReasonCodes.CONTENT_PRIZE })
        assertTrue(arabizi.reasons.any { it.code == ReasonCodes.CONTENT_CREDENTIAL_REQUEST && it.hard })

        val ar = chat("+440000000045", "بنك أبوظبي التجاري: تم إيقاف بطاقتك. للتفعيل أرسل رمز التحقق الذي وصلك الآن.")
        assertEquals(Level.HOLD, ar.level, codes(ar))

        val otpNegated = sms("ADIB", "مصرف أبوظبي الإسلامي: رمز التحقق الخاص بك هو 918273. لا تشارك هذا الرمز مع أي شخص، ولا ترسله لأي موظف.")
        assertEquals(Level.ALLOW, otpNegated.level, codes(otpNegated))
    }

    @Test
    fun `small fee needs a link to be hard and large amounts never count`() {
        val noLink = sms("+440000000046", "Emirates Post: customs fee AED 4.90 is pending on your parcel.")
        assertTrue(noLink.reasons.any { it.code == ReasonCodes.CONTENT_SMALL_FEE_LINK && !it.hard }, codes(noLink))
        val big = sms("+971500000047", "Customs fee AED 490 is pending: http://pay-customs.example/x")
        assertTrue(big.reasons.none { it.code == ReasonCodes.CONTENT_SMALL_FEE_LINK }, codes(big))
    }
}
