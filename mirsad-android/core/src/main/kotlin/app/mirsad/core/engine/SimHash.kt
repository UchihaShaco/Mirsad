package app.mirsad.core.engine

/**
 * 64-bit SimHash over the normalised text with numbers masked to "#" and URLs to "<url>".
 * Features: word unigrams and bigrams, plus character trigrams for short texts.
 * Output: 16 lowercase hex chars; [ZERO] when there is no text.
 */
object SimHash {
    const val ZERO = "0000000000000000"

    fun fingerprint(normalisedText: String): String {
        val tokens = tokens(normalisedText)
        if (tokens.isEmpty()) return ZERO
        val counts = IntArray(64)
        fun add(feature: String) {
            val h = fnv1a64(feature)
            for (bit in 0 until 64) {
                if ((h ushr bit) and 1L == 1L) counts[bit]++ else counts[bit]--
            }
        }
        for (t in tokens) add("u:$t")
        for (i in 0 until tokens.size - 1) add("b:" + tokens[i] + " " + tokens[i + 1])
        if (tokens.size < SHORT_TEXT_TOKENS) {
            val s = tokens.joinToString("_")
            for (i in 0..s.length - 3) add("c:" + s.substring(i, i + 3))
        }
        var out = 0L
        for (bit in 0 until 64) if (counts[bit] > 0) out = out or (1L shl bit)
        return toHex(out)
    }

    /** Masked token stream the fingerprint is built from (exposed for tests). */
    fun tokens(normalisedText: String): List<String> {
        if (normalisedText.isBlank()) return emptyList()
        val masked = normalisedText
            .replace(URL, " <url> ")
            .replace(NUMBER, " # ")
            .replace(PUNCT, " ")
        return masked.split(' ').filter { it.isNotEmpty() }
    }

    fun hamming(a: String, b: String): Int = java.lang.Long.bitCount(parse(a) xor parse(b))

    fun parse(hex: String): Long = java.lang.Long.parseUnsignedLong(hex, 16)

    fun toHex(value: Long): String = java.lang.Long.toHexString(value).padStart(16, '0')

    fun fnv1a64(s: String): Long {
        var h = -0x340d631b7bdddcdbL // FNV offset basis 14695981039346656037
        for (ch in s) {
            val c = ch.code
            h = h xor (c and 0xFF).toLong()
            h *= 0x100000001b3L
            h = h xor ((c ushr 8) and 0xFF).toLong()
            h *= 0x100000001b3L
        }
        return h
    }

    private const val SHORT_TEXT_TOKENS = 6
    private val URL = Regex("https?://\\S+|www\\.\\S+|\\b[a-z0-9-]{0,62}[a-z][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63}){1,8}(?:/\\S*)?")
    private val NUMBER = Regex("\\d+(?:[.,:]\\d+)*")
    private val PUNCT = Regex("[^\\p{L}\\p{N}#<>_ ]+")
}
