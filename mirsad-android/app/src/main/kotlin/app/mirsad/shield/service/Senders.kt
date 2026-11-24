package app.mirsad.shield.service

import app.mirsad.core.contract.SenderType

/** Sender parsing shared by the listener, call screening and the pipeline. No contacts access. */
object Senders {
    /** Punctuation and invisible marks that apps put around displayed numbers (NBSP, LRM/RLM, bidi embeddings). */
    private val formatting: Set<Char> =
        setOf('-', '(', ')', '.', 0x00A0.toChar(), 0x200E.toChar(), 0x200F.toChar()) + (0x202A..0x202E).map(Int::toChar)

    /** True when the raw title is a phone number such as "+971 50 000 0003" or "0500000003". */
    fun looksLikePhoneNumber(raw: String?): Boolean {
        val cleaned = raw?.filterNot { it.isWhitespace() || it in formatting } ?: return false
        val body = cleaned.removePrefix("+")
        return body.length in 6..16 && body.all { it.isDigit() }
    }

    /**
     * Normalises a number to E.164 with default region AE:
     * 05x... -> +9715x..., 0 + area -> +971..., 00 + country -> +country, 971... -> +971...
     */
    fun toE164(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        if (digits.isEmpty()) return raw.trim()
        val hasPlus = raw.trimStart().startsWith("+")
        return when {
            hasPlus -> "+$digits"
            digits.startsWith("00") -> "+" + digits.drop(2)
            digits.startsWith("0") -> "+971" + digits.drop(1)
            digits.startsWith("971") && digits.length >= 11 -> "+$digits"
            digits.length <= 9 -> "+971$digits"
            else -> "+$digits"
        }
    }

    /** SMS sender IDs such as "ADCB", "DEWA" or "ADNOC": short, no spaces, no lowercase letters. */
    fun looksLikeAlphanumericId(raw: String): Boolean {
        val s = raw.trim()
        return s.length in 2..11 &&
            s.none { it.isWhitespace() } &&
            s.any { it.isLetter() } &&
            s.none { it.isLowerCase() } &&
            s.all { it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' }
    }

    fun senderTypeOf(sender: String, looksLikeContact: Boolean): SenderType = when {
        looksLikePhoneNumber(sender) -> SenderType.NUMBER
        looksLikeContact -> SenderType.CONTACT
        sender.isBlank() -> SenderType.UNKNOWN
        else -> SenderType.ALPHANUMERIC
    }

    /** List value for a sender: E.164 for numbers, lowercase for IDs and names. */
    fun listValue(sender: String, type: SenderType): String =
        if (type == SenderType.NUMBER) toE164(sender) else sender.trim().lowercase()
}
