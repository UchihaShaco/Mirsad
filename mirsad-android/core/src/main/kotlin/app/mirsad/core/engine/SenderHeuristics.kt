package app.mirsad.core.engine

import app.mirsad.core.contract.Channel

/**
 * How a sender's displayed name is read, shared by the notification listener and the laptop CLI so both decide the
 * same way. Mirsad never reads contacts: a displayed name is only treated as a saved contact (which caps the verdict
 * at WARN), and on SMS a single short token is a carrier sender ID instead, whatever its case, so a spoofed brand ID
 * such as "ADCB-Alert" never gets the contact cap.
 */
object SenderHeuristics {
    /** An SMS alphanumeric sender ID such as "ADCB", "AD-POLICE" or "ETISALAT". */
    fun looksLikeAlphanumericId(raw: String): Boolean {
        val s = raw.trim()
        return s.length in 2..11 &&
            s.none { it.isWhitespace() } &&
            s.any { it.isLetter() } &&
            s.none { it.isLowerCase() } &&
            s.all { it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' }
    }

    /** [isNumber]: the caller's own test that the sender is a phone number. */
    fun looksLikeContact(sender: String, channel: Channel, isNumber: Boolean): Boolean {
        val s = sender.trim()
        val smsSenderId = channel == Channel.SMS && s.length in 2..11 && s.none { it.isWhitespace() }
        return !isNumber && s.isNotBlank() && s.any { it.isLetter() } && !smsSenderId &&
            !(channel == Channel.SMS && looksLikeAlphanumericId(s))
    }
}
