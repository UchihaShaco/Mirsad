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

/**
 * Mirsad contact sync puts every flagged number on one "⚠️ Known Scammer" contact, so a messaging app shows that name
 * instead of the number. The name is a block-list hit, never the saved-contact cap (rules.json "senders").
 */
class KnownScammerContactTest {
    private val engine = MirsadEngineFactory.create()
    private val rules = RuleSet.loadFromResources()
    private val now = 1_700_000_000_000L

    // The listener passes contact = true for any displayed name (SenderHeuristics.looksLikeContact).
    private fun sms(sender: String, text: String) =
        Event(Channel.SMS, sender, text, "com.google.android.apps.messaging", now, senderLooksLikeContact = true)

    private val benign = "Hi, are you free to talk later today?"

    @Test
    fun `the contact sync name, its continuations and the Arabic form are recognised`() {
        for (name in listOf(
            "⚠️ Known Scammer", "⚠️ Known Scammer 2", "⚠️ Known Scammer 12", "⚠️ محتال معروف", "⚠️ محتال معروف ٣",
        )) {
            assertTrue(rules.isKnownScammerContact(name), name)
        }
    }

    @Test
    fun `direction marks, variation selectors and spacing around the name are tolerated`() {
        for (name in listOf(
            "⚠ Known Scammer", // no variation selector
            "⁨⚠️ Known Scammer⁩", // first-strong isolate, as Android wraps names in notifications
            "‎⚠️ Known Scammer 2‎",
            "‏⚠️ محتال معروف‏",
            "⚠︎  known  scammer ", // text presentation selector, case and spaces
        )) {
            assertTrue(rules.isKnownScammerContact(name), name)
        }
    }

    @Test
    fun `ordinary contacts are not the known scammer contact`() {
        for (name in listOf("Scammer Sam", "Known Scammer Sam", "⚠️ Known Scammer Sam", "Mom", "Known", "⚠️ Known Scammer 1234", "")) {
            assertFalse(rules.isKnownScammerContact(name), name)
        }
    }

    @Test
    fun `a message from the known scammer contact holds at every sensitivity with its own reason`() {
        for (s in Sensitivity.values()) {
            for (name in listOf("⚠️ Known Scammer", "⁨⚠️ Known Scammer 2⁩", "⚠️ محتال معروف")) {
                val v = engine.analyse(sms(name, benign), EngineContext(sensitivity = s))
                assertEquals(Level.HOLD, v.level, "$name at $s")
                assertTrue(v.reasons.any { it.code == ReasonCodes.SENDER_KNOWN_SCAMMER_CONTACT && it.hard }, "$name at $s")
                assertTrue(v.reasons.none { it.code == ReasonCodes.SENDER_LOOKS_LIKE_CONTACT }, "not capped as a contact")
            }
        }
    }

    @Test
    fun `an ordinary contact keeps the contact cap`() {
        val v = engine.analyse(sms("Scammer Sam", benign), EngineContext())
        assertEquals(Level.ALLOW, v.level)
        assertTrue(v.reasons.any { it.code == ReasonCodes.SENDER_LOOKS_LIKE_CONTACT })
        assertTrue(v.reasons.none { it.code == ReasonCodes.SENDER_KNOWN_SCAMMER_CONTACT })
    }

    @Test
    fun `not a scam on that message stops holding the same text but not other messages from the contact`() {
        val held = engine.analyse(sms("⚠️ Known Scammer", benign), EngineContext())
        val afterOverrule = EngineContext(knownGoodFingerprints = setOf(held.fingerprint))
        assertNotEquals(Level.HOLD, engine.analyse(sms("⚠️ Known Scammer", benign), afterOverrule).level)
        val other = engine.analyse(sms("⚠️ Known Scammer", "Your account is locked, send the code we texted you."), afterOverrule)
        assertEquals(Level.HOLD, other.level)
    }
}
