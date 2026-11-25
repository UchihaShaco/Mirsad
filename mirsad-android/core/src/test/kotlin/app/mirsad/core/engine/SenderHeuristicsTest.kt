package app.mirsad.core.engine

import app.mirsad.core.contract.Channel
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SenderHeuristicsTest {
    @Test
    fun `an SMS sender ID is never a contact, whatever its case`() {
        for (id in listOf("ADCB", "ADCB-Alert", "EmiratesNBD", "Aramex", "AD-POLICE")) {
            assertFalse(SenderHeuristics.looksLikeContact(id, Channel.SMS, isNumber = false), id)
        }
    }

    @Test
    fun `a name with a space is a contact on SMS, and a chat name is a contact`() {
        assertTrue(SenderHeuristics.looksLikeContact("Sara Ali", Channel.SMS, isNumber = false))
        assertTrue(SenderHeuristics.looksLikeContact("ADCB", Channel.CHAT, isNumber = false))
    }

    @Test
    fun `a number or an empty sender is never a contact`() {
        assertFalse(SenderHeuristics.looksLikeContact("+971 50 000 0301", Channel.SMS, isNumber = true))
        assertFalse(SenderHeuristics.looksLikeContact("   ", Channel.CHAT, isNumber = false))
    }
}
