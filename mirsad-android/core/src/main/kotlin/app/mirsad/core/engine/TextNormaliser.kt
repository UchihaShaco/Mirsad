package app.mirsad.core.engine

import app.mirsad.core.contract.Language
import java.text.Normalizer

/**
 * Normalises message text before any rule runs, and detects the language of the result.
 *
 * Normalisation: NFKC, strip tashkeel and tatweel, unify alef forms (أإآٱ → ا), ya (ى → ي),
 * ta marbuta (ة → ه), Persian kaf/ya to Arabic, Arabic-Indic and Persian digits to ASCII,
 * drop bidi/zero-width controls, lowercase, collapse whitespace.
 */
class TextNormaliser(private val arabizi: ArabiziLexicon = ArabiziLexicon.EMPTY) {

    fun normalise(text: String?): String {
        if (text.isNullOrEmpty()) return ""
        val nfkc = Normalizer.normalize(text, Normalizer.Form.NFKC)
        val sb = StringBuilder(nfkc.length)
        for (ch in nfkc) {
            when {
                ch in 'ً'..'ٟ' || ch == 'ٰ' || ch in 'ۖ'..'ۭ' -> Unit // tashkeel
                ch == 'ـ' -> Unit // tatweel
                ch in '​'..'‏' || ch in '‪'..'‮' || ch in '⁦'..'⁩' || ch == '﻿' -> Unit
                ch == 'أ' || ch == 'إ' || ch == 'آ' || ch == 'ٱ' -> sb.append('ا')
                ch == 'ى' || ch == 'ی' -> sb.append('ي')
                ch == 'ة' -> sb.append('ه')
                ch == 'ک' -> sb.append('ك')
                ch in '٠'..'٩' -> sb.append('0' + (ch - '٠'))
                ch in '۰'..'۹' -> sb.append('0' + (ch - '۰'))
                ch == ' ' -> sb.append(' ')
                else -> sb.append(ch)
            }
        }
        return sb.toString().lowercase().replace(WHITESPACE, " ").trim()
    }

    /** Language of an already-normalised text. URLs are ignored when counting scripts. */
    fun detectLanguage(normalised: String): Language {
        if (normalised.isEmpty()) return Language.UNKNOWN
        val body = normalised.replace(URL_LIKE, " ")
        var arabic = 0
        var latin = 0
        for (ch in body) {
            when {
                ch in 'a'..'z' -> latin++
                isArabicLetter(ch) -> arabic++
                ch.isLetter() -> latin++
            }
        }
        if (arabic == 0 && latin == 0) return Language.UNKNOWN
        if (arabic >= latin) return Language.AR
        if (arabic == 0 && arabiziScore(body) >= ARABIZI_THRESHOLD) return Language.LATIN_ARABIC
        return Language.EN
    }

    /** Arabizi evidence: strong tokens 2, weak tokens 1, digit-as-letter tokens 2. */
    fun arabiziScore(text: String): Int {
        var score = 0
        for (token in text.split(TOKEN_SPLIT)) {
            if (token.isEmpty()) continue
            when {
                token in arabizi.strong -> score += 2
                token in arabizi.weak -> score += 1
                DIGIT_LETTER.matches(token) -> score += 2
            }
        }
        return score
    }

    private fun isArabicLetter(ch: Char): Boolean =
        (ch in 'ؠ'..'ي') || (ch in 'ٮ'..'ۓ') || (ch in 'ݐ'..'ݿ') || (ch in 'ࢠ'..'ࣿ')

    companion object {
        private val WHITESPACE = Regex("\\s+")
        private val URL_LIKE = Regex("https?://\\S+|www\\.\\S+|\\b[a-z0-9-]{0,62}[a-z][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63}){1,8}(?:/\\S*)?")
        private val TOKEN_SPLIT = Regex("[^a-z0-9']+")
        /** A token with letters and one of the digits Arabizi uses for Arabic letters (2 3 5 7 9). */
        private val DIGIT_LETTER = Regex("[a-z]+[23579][a-z]+|[23579][a-z]{2,}|[a-z]{2,}[37]")
        private const val ARABIZI_THRESHOLD = 3
    }
}

/** Arabizi token lists, loaded from rules.json. */
class ArabiziLexicon(strong: Collection<String>, weak: Collection<String>) {
    val strong: Set<String> = strong.map { it.lowercase() }.toHashSet()
    val weak: Set<String> = weak.map { it.lowercase() }.toHashSet()

    companion object {
        val EMPTY = ArabiziLexicon(emptyList(), emptyList())
    }
}
