package app.mirsad.core.ml

/**
 * Text normalisation used for every text the classifier sees, at training time and at inference time.
 *
 * The function is idempotent: normalising an already-normalised string returns it unchanged. The engine
 * passes pre-normalised text to [app.mirsad.core.contract.Classifier.scoreScam]; [ModelClassifier] applies
 * this function again, so it does not matter whether the caller normalised or not.
 *
 * Steps, in order: lowercase; drop zero-width and control characters; strip Arabic diacritics and tatweel;
 * unify alef / ya / ta-marbuta and Persian kaf/ya; Arabic-Indic digits to ASCII; Arabic punctuation to ASCII;
 * mask e-mails to " <email> ", URLs and bare domains to " <url> ", digit runs to "#"; collapse whitespace.
 */
fun normaliseForModel(text: String): String = TextNormaliser.normaliseForModel(text)

object TextNormaliser {
    const val URL_TOKEN = "<url>"
    const val EMAIL_TOKEN = "<email>"
    const val DIGIT_TOKEN = "#"

    private val EMAIL = Regex("""(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,6}\.[a-z]{2,24}""")
    private val SCHEME_URL = Regex("""(?:https?://|www\.)[^\s<>"']+""")
    // A bare domain such as salik.ae, t.me/abc or emiratespost-ae.fee.example/pay. The TLD must be letters so
    // that decimals such as "3.50" and times such as "9.30" are not treated as hosts.
    private val BARE_DOMAIN = Regex("""(?<![\w@.\-#])(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}(?:/[^\s<>"']*)?(?![\w.-]*@)""")
    private val DIGITS = Regex("""[0-9]+""")
    private val WHITESPACE = Regex("""\s+""")

    fun normaliseForModel(text: String): String {
        if (text.isEmpty()) return text
        val lower = text.lowercase()
        val sb = StringBuilder(lower.length)
        for (ch in lower) {
            when {
                isZeroWidth(ch) -> Unit
                ch.isISOControl() -> sb.append(' ')
                isArabicDiacritic(ch) -> Unit
                ch == 'ـ' -> Unit // tatweel
                ch == 'آ' || ch == 'أ' || ch == 'إ' || ch == 'ٱ' -> sb.append('ا') // alef
                ch == 'ى' || ch == 'ی' -> sb.append('ي') // ya
                ch == 'ة' -> sb.append('ه') // ta marbuta -> ha
                ch == 'ک' -> sb.append('ك') // Persian kaf -> kaf
                ch in '٠'..'٩' -> sb.append(('0'.code + (ch - '٠')).toChar())
                ch in '۰'..'۹' -> sb.append(('0'.code + (ch - '۰')).toChar())
                ch == '،' -> sb.append(',')
                ch == '؛' -> sb.append(';')
                ch == '؟' -> sb.append('?')
                ch == '٪' -> sb.append('%')
                ch == '٫' || ch == '٬' -> sb.append(if (ch == '٫') '.' else ',')
                else -> sb.append(ch)
            }
        }
        var s = sb.toString()
        s = EMAIL.replace(s, " $EMAIL_TOKEN ")
        s = SCHEME_URL.replace(s, " $URL_TOKEN ")
        s = BARE_DOMAIN.replace(s, " $URL_TOKEN ")
        s = DIGITS.replace(s, DIGIT_TOKEN)
        return WHITESPACE.replace(s, " ").trim()
    }

    private fun isZeroWidth(ch: Char): Boolean =
        ch in '​'..'‏' || ch == '﻿' || ch in '‪'..'‮' || ch in '⁦'..'⁩'

    private fun isArabicDiacritic(ch: Char): Boolean =
        ch in 'ؐ'..'ؚ' || ch in 'ً'..'ٟ' || ch == 'ٰ' || ch in 'ۖ'..'ۭ'
}
