package app.mirsad.core.engine

import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.Sensitivity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** Policy rules of the HOLD gate that the lead owns: they encode the false-positive section of the spec. */
class GatePolicyTest {
    private val engine = MirsadEngineFactory.create()
    private val now = 1_700_000_000_000L

    private fun sms(sender: String, text: String, contact: Boolean = false) =
        Event(Channel.SMS, sender, text, "com.google.android.apps.messaging", now, contact)

    private fun call(number: String) = Event(Channel.CALL, number, null, null, now, false)

    private val parcel = "Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours or it will be " +
        "returned: http://emiratespost-ae.delivery-fee.example/pay"

    @Test
    fun `held-number rule is hard evidence for calls and holds at every sensitivity`() {
        for (s in Sensitivity.values()) {
            val v = engine.analyse(
                call("+447000000001"),
                EngineContext(sensitivity = s, recentlyHeldNumbers = setOf("+447000000001"), stageOneOnly = true),
            )
            assertEquals(Level.HOLD, v.level, "call from a recently held number at $s")
            assertTrue(v.reasons.any { it.code == ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE && it.hard })
        }
    }

    @Test
    fun `held-number rule alone never holds a follow-up message`() {
        for (s in Sensitivity.values()) {
            val v = engine.analyse(
                sms("+447000000001", "Hello, did you get my last message?"),
                EngineContext(sensitivity = s, recentlyHeldNumbers = setOf("+447000000001")),
            )
            assertNotEquals(Level.HOLD, v.level, "follow-up message at $s")
            assertTrue(v.reasons.none { it.code == ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE && it.hard })
        }
        val balanced = engine.analyse(
            sms("+447000000001", "Hello, did you get my last message?"),
            EngineContext(recentlyHeldNumbers = setOf("+447000000001")),
        )
        assertEquals(Level.WARN, balanced.level, "a follow-up from a recently held sender is worth a caution")
    }

    @Test
    fun `an unknown call with no list hit is never held`() {
        for (number in listOf("+971500000077", "+447000000009", "+8801000000001", "0500000077")) {
            for (s in Sensitivity.values()) {
                val v = engine.analyse(call(number), EngineContext(sensitivity = s, stageOneOnly = true))
                assertNotEquals(Level.HOLD, v.level, "call from $number at $s")
            }
        }
    }

    @Test
    fun `a block-listed sender holds at every sensitivity, for calls and messages`() {
        for (s in Sensitivity.values()) {
            val ctx = EngineContext(sensitivity = s, blockedSenders = setOf("+971500000088"), stageOneOnly = true)
            assertEquals(Level.HOLD, engine.analyse(call("+971500000088"), ctx).level, "blocked call at $s")
            assertEquals(Level.HOLD, engine.analyse(call("0500000088"), ctx).level, "blocked call in national format at $s")
            assertEquals(
                Level.HOLD,
                engine.analyse(sms("+971500000088", "Hi"), ctx.copy(stageOneOnly = false)).level,
                "blocked sender message at $s",
            )
        }
    }

    @Test
    fun `a block-listed domain or fingerprint holds at every sensitivity`() {
        val text = "Your order is confirmed. Details: https://shop.blocked-campaign.example/o/1"
        val fingerprint = engine.analyse(sms("+971500000031", text)).fingerprint
        for (s in Sensitivity.values()) {
            val byDomain = engine.analyse(
                sms("+971500000031", text),
                EngineContext(sensitivity = s, blockedDomains = setOf("blocked-campaign.example")),
            )
            assertEquals(Level.HOLD, byDomain.level, "blocked domain at $s")
            val byFingerprint = engine.analyse(
                sms("+971500000032", text),
                EngineContext(sensitivity = s, blockedFingerprints = setOf(fingerprint)),
            )
            assertEquals(Level.HOLD, byFingerprint.level, "blocked fingerprint at $s")
        }
    }

    @Test
    fun `never-HOLD caps beat a block-list hit`() {
        val ctx = EngineContext(blockedSenders = setOf("khalid"), blockedDomains = setOf("delivery-fee.example"))
        val contact = engine.analyse(Event(Channel.CHAT, "Khalid", parcel, "com.whatsapp", now, true), ctx)
        assertNotEquals(Level.HOLD, contact.level, "a sender that looks like a saved contact is WARN at most")
        val allowed = engine.analyse(
            sms("+447000000001", parcel),
            EngineContext(allowedSenders = setOf("+447000000001"), blockedDomains = setOf("delivery-fee.example")),
        )
        assertEquals(Level.ALLOW, allowed.level, "the allow list wins")
        val hidden = engine.analyse(
            Event(Channel.SMS, "+447000000001", null, null, now, false, contentHidden = true),
            EngineContext(blockedSenders = setOf("+447000000001")),
        )
        assertEquals(Level.ALLOW, hidden.level, "hidden content is never a scam")
    }

    @Test
    fun `a bare small fee with a link from a local number warns but does not hold`() {
        val shop = listOf(
            "Al Noor Laundry: your order 118 is ready. Pay AED 35 on delivery or online: http://alnoor-laundry.example/pay",
            "Hi, this is Ahmed from Bright Kids Nursery. Trip fee of AED 25 is due today. Pay here: https://brightkids.example/pay/trip",
            "Dr. Sara Dental Clinic: your appointment is tomorrow 10:00. Confirm and pay the AED 40 booking fee here: https://sara-dental.example/confirm",
            "Desert Riders Club: membership renewal AED 45 due today. Pay at https://desert-riders.example/pay",
        )
        for (text in shop) {
            for (s in listOf(Sensitivity.RELAXED, Sensitivity.BALANCED)) {
                val v = engine.analyse(sms("+971500000021", text), EngineContext(sensitivity = s))
                assertNotEquals(Level.HOLD, v.level, "local shop payment link at $s: $text")
                assertFalse(v.reasons.any { it.code == ReasonCodes.CONTENT_SMALL_FEE_LINK && it.hard }, "uncorroborated small fee is soft")
            }
        }
    }

    @Test
    fun `a small fee with a link is hard evidence when corroborated`() {
        // Named entity + brand in host + foreign number.
        val v1 = engine.analyse(sms("+447000000001", parcel))
        assertEquals(Level.HOLD, v1.level)
        assertTrue(v1.reasons.any { it.code == ReasonCodes.CONTENT_SMALL_FEE_LINK && it.hard })
        // No entity named, local number, but a shortener hides the destination.
        val v2 = engine.analyse(sms("+971500000033", "Your parcel is waiting. Pay the AED 4 redelivery fee now: https://bit.ly/x1example"))
        assertTrue(v2.reasons.any { it.code == ReasonCodes.CONTENT_SMALL_FEE_LINK && it.hard }, "shortener corroborates: ${v2.reasons}")
        // No entity, local number, plain link, but a threat.
        val v3 = engine.analyse(sms("+971500000034", "Pay the AED 6 customs fee today or your parcel will be returned: http://parcel-release.example/pay"))
        assertTrue(v3.reasons.any { it.code == ReasonCodes.CONTENT_SMALL_FEE_LINK && it.hard }, "threat corroborates: ${v3.reasons}")
    }

    @Test
    fun `the classifier alone can never hold`() {
        val always = object : app.mirsad.core.contract.Classifier {
            override val modelVersion = "always-scam"
            override fun scoreScam(normalisedText: String) = 1.0
        }
        val e = MirsadEngineFactory.create(always)
        for (s in Sensitivity.values()) {
            val v = e.analyse(sms("+971500000035", "See you at the majlis after maghrib."), EngineContext(sensitivity = s))
            assertNotEquals(Level.HOLD, v.level, "model score alone at $s")
        }
    }

    @Test
    fun `a friend's new number with an IBAN is held and that is the documented false positive`() {
        val v = engine.analyse(
            Event(
                Channel.CHAT, "+971500000041",
                "Hi, it is Omar, this is my new number. Can you transfer the AED 500 for the football pitch today? " +
                    "My IBAN is AE440330000000000000042",
                "com.whatsapp", now, false,
            ),
        )
        assertEquals(Level.HOLD, v.level, "used by the Demo screen as the honest wrongly-held example")
        assertTrue(v.reasons.any { it.code == ReasonCodes.CONTENT_PAYMENT_REQUEST && it.hard })
    }
}
