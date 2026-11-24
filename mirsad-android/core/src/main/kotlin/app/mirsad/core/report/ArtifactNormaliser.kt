package app.mirsad.core.report

import java.net.IDN

/**
 * Normalisation shared by the report builder and the blocklist import. Pure Kotlin.
 *
 * - phone numbers -> E.164 (`+971500000003`), default country code 971 (UAE)
 * - domains -> lowercase registrable domain (`delivery-fee.example`)
 * - fingerprints -> 16 lowercase hex chars
 *
 * Every function returns null for a value it cannot make sense of; callers drop those and count them.
 */
object ArtifactNormaliser {
    const val DEFAULT_COUNTRY_CODE = "971"

    private val e164 = Regex("^\\+[1-9][0-9]{7,14}$")
    private val label = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    private val hex16 = Regex("^[0-9a-f]{16}$")
    private val scheme = Regex("^[a-z][a-z0-9+.-]*://")
    private val port = Regex(":[0-9]+$")

    /**
     * Two-label public suffixes under which the registrable domain is the third label from the right
     * (`pay.bank-update.co.ae` -> `bank-update.co.ae`). A short list, not the full public suffix list.
     */
    private val twoLabelSuffixes = setOf(
        "ac.ae", "co.ae", "gov.ae", "mil.ae", "net.ae", "org.ae", "sch.ae",
        "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa", "com.qa", "com.kw", "com.bh", "com.om", "com.jo",
        "com.lb", "com.eg", "com.tr",
        "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
        "com.au", "net.au", "org.au", "co.nz", "co.za", "co.in", "net.in", "org.in", "com.pk", "com.bd",
        "com.my", "com.sg", "com.ph", "co.id", "com.vn", "com.hk", "com.tw", "com.cn", "co.jp", "co.kr",
        "com.br", "com.mx", "com.ar", "com.ng", "co.ke", "co.il",
    )

    /**
     * E.164 or null. Accepts `+`, `00` and local (`05...`) forms, Arabic-Indic digits and common separators.
     * Anything with letters (alphanumeric sender IDs, short codes with text) is not a phone number.
     */
    fun phone(raw: String, defaultCountryCode: String = DEFAULT_COUNTRY_CODE): String? {
        val sb = StringBuilder()
        for (ch in raw.trim()) {
            val digit = asciiDigit(ch)
            when {
                digit != null -> sb.append(digit)
                ch == '+' && sb.isEmpty() -> sb.append('+')
                ch in SEPARATORS -> Unit
                else -> return null
            }
        }
        val s = sb.toString()
        if (s.isEmpty()) return null
        val cc = defaultCountryCode.trimStart('+')
        val candidate = when {
            s.startsWith("+") -> s
            s.startsWith("00") -> "+" + s.substring(2)
            s.startsWith("0") -> "+" + cc + s.substring(1)
            s.length >= 11 -> "+$s"
            s.length in 8..9 -> "+$cc$s"
            else -> return null
        }
        return candidate.takeIf { e164.matches(it) }
    }

    /** Lowercase registrable domain or null. Accepts a bare host or a full URL; IP literals are not domains. */
    fun domain(raw: String): String? {
        var s = raw.trim().lowercase()
        if (s.isEmpty()) return null
        s = s.replace(scheme, "")
        s = s.takeWhile { it != '/' && it != '?' && it != '#' }
        s = s.substringAfterLast('@')
        s = s.replace(port, "")
        s = s.trim('.')
        if (s.isEmpty()) return null
        if (s.any { it.code > 127 }) {
            s = try {
                IDN.toASCII(s, IDN.ALLOW_UNASSIGNED).lowercase()
            } catch (e: IllegalArgumentException) {
                return null
            }
        }
        val labels = s.split('.')
        if (labels.size < 2 || labels.any { !label.matches(it) }) return null
        val tld = labels.last()
        if (!(tld.all { it in 'a'..'z' } || tld.startsWith("xn--"))) return null
        val suffix = labels[labels.size - 2] + "." + tld
        val keep = if (labels.size >= 3 && suffix in twoLabelSuffixes) 3 else 2
        return labels.takeLast(keep).joinToString(".")
    }

    /** 16 lowercase hex chars or null. */
    fun fingerprint(raw: String): String? {
        val s = raw.trim().lowercase().removePrefix("0x")
        return s.takeIf { hex16.matches(it) }
    }

    private val SEPARATORS = setOf(' ', '-', '(', ')', '.', '/', ' ', '‎', '‏', '‪', '‬')

    private fun asciiDigit(ch: Char): Char? = when (ch) {
        in '0'..'9' -> ch
        in '٠'..'٩' -> '0' + (ch - '٠') // Arabic-Indic digits
        in '۰'..'۹' -> '0' + (ch - '۰') // Extended Arabic-Indic digits
        else -> null
    }
}
