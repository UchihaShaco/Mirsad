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

    /**
     * True when [displayName] is the "Known Scammer" contact Mirsad contact sync writes ("⚠️ Known Scammer",
     * "⚠️ Known Scammer 2", "⚠️ محتال معروف"…). [canonicalNames] are already passed through [canonicalName].
     * Messaging apps wrap names in direction marks and drop or add emoji variation selectors; both are ignored.
     */
    fun isKnownScammerContact(displayName: String, canonicalNames: Set<String>): Boolean {
        if (canonicalNames.isEmpty()) return false
        val name = canonicalName(displayName)
        if (name in canonicalNames) return true
        val base = CONTINUATION.matchEntire(name)?.groupValues?.get(1) ?: return false
        return base in canonicalNames
    }

    /** Lower case, invisible format characters and variation selectors removed, spaces collapsed. */
    fun canonicalName(raw: String): String =
        raw.replace(INVISIBLE, "").replace(SPACES, " ").trim().lowercase()

    // Direction marks and isolates (LRM, RLM, ALM, LRE..RLO, LRI..PDI), zero-width characters, variation selectors.
    private val INVISIBLE = Regex("[\\u200B-\\u200F\\u061C\\u202A-\\u202E\\u2066-\\u2069\\uFEFF\\uFE00-\\uFE0F]")
    private val SPACES = Regex("\\s+")
    /** "<name> 2": a numbered continuation, in Western or Arabic-Indic digits. */
    private val CONTINUATION = Regex("(.+?) [0-9\\u0660-\\u0669\\u06F0-\\u06F9]{1,3}")
}
