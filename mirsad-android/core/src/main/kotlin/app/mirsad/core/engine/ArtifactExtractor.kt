package app.mirsad.core.engine

import app.mirsad.core.contract.Artifact
import app.mirsad.core.contract.ArtifactType

/** Phone number helpers. Default region AE. */
object PhoneNumbers {
    /**
     * Converts a raw number to E.164 (+971...). 800/600 service numbers are kept as-is.
     * Returns null when the digits do not form a plausible number.
     */
    fun toE164(raw: String): String? {
        var s = raw.trim().filter { it.isDigit() || it == '+' }
        if (s.startsWith("00")) s = "+" + s.substring(2)
        val plus = s.startsWith("+")
        val digits = s.trimStart('+')
        if (digits.isEmpty() || digits.contains('+')) return null
        if (plus) {
            if (digits.startsWith("9710") && digits.length == 13) return "+971" + digits.substring(4)
            return if (digits.length in 7..15 && digits[0] != '0') "+$digits" else null
        }
        return when {
            digits.startsWith("9710") && digits.length == 13 -> "+971" + digits.substring(4)
            digits.startsWith("971") && digits.length in 11..12 -> "+$digits"
            digits.startsWith("05") && digits.length == 10 -> "+971" + digits.substring(1)
            digits.length == 9 && digits[0] == '5' -> "+971$digits"
            digits.length == 9 && digits[0] == '0' && digits[1] in LANDLINE_AREA -> "+971" + digits.substring(1)
            digits.startsWith("800") && digits.length in 7..10 -> digits
            digits.startsWith("600") && digits.length == 9 -> digits
            else -> null
        }
    }

    fun isUae(e164: String): Boolean = e164.startsWith("+971") || e164.startsWith("800") || e164.startsWith("600")

    private const val LANDLINE_AREA = "2346789"
}

/** Extracts phones, URLs/domains, IBANs, emails, crypto wallets and messenger handles. Deduplicated. */
class ArtifactExtractor {

    fun extract(originalText: String, normalisedText: String, links: List<ExtractedLink>): List<Artifact> {
        if (normalisedText.isEmpty()) return emptyList()
        val out = LinkedHashSet<Artifact>()
        for (link in links) {
            if (link.isMessengerHandle) continue
            out += Artifact(ArtifactType.URL, link.raw)
            out += Artifact(ArtifactType.DOMAIN, link.registrableDomain)
        }
        for (m in WA_ME.findAll(normalisedText)) out += Artifact(ArtifactType.HANDLE, "wa.me/" + m.groupValues[1].trimStart('+'))
        for (m in WHATSAPP_SEND.findAll(normalisedText)) out += Artifact(ArtifactType.HANDLE, "wa.me/" + m.groupValues[1].trimStart('+'))
        for (m in T_ME.findAll(normalisedText)) out += Artifact(ArtifactType.HANDLE, "t.me/" + m.groupValues[1])
        for (m in EMAIL.findAll(normalisedText)) out += Artifact(ArtifactType.EMAIL, m.value)
        for (m in PHONE.findAll(normalisedText)) {
            if (m.value.filter { it.isDigit() }.length < 7) continue
            PhoneNumbers.toE164(m.value)?.let { out += Artifact(ArtifactType.PHONE, it) }
        }
        for (m in IBAN_CANDIDATE.findAll(originalText)) {
            Iban.normalise(m.value)?.let { out += Artifact(ArtifactType.IBAN, it) }
        }
        for (m in BTC.findAll(originalText)) out += Artifact(ArtifactType.WALLET, m.value)
        for (m in ETH.findAll(originalText)) out += Artifact(ArtifactType.WALLET, m.value)
        for (m in TRON.findAll(originalText)) out += Artifact(ArtifactType.WALLET, m.value)
        return out.toList()
    }

    companion object {
        private val WA_ME = Regex("(?:https?://)?(?:www\\.)?wa\\.me/(\\+?\\d{6,15})")
        private val WHATSAPP_SEND = Regex("(?:https?://)?(?:api\\.|www\\.)?whatsapp\\.com/send/?\\?phone=(\\+?\\d{6,15})")
        private val T_ME = Regex("(?:https?://)?(?:www\\.)?(?:t\\.me|telegram\\.me)/(\\+?[a-z0-9_]{3,64})")
        private val EMAIL = Regex("[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,24}")
        private val PHONE = Regex("(?<![\\p{L}\\p{N}@.])(?:\\+|00)?\\d[\\d\\s().-]{5,18}\\d(?![\\p{L}\\p{N}])")
        private val IBAN_CANDIDATE = Regex("(?<![A-Za-z0-9])[A-Za-z]{2}\\d{2}(?:[ \\-]?[A-Za-z0-9]){11,34}")
        private val BTC = Regex("(?<![A-Za-z0-9])(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})(?![A-Za-z0-9])")
        private val ETH = Regex("(?<![A-Za-z0-9])0x[a-fA-F0-9]{40}(?![A-Za-z0-9])")
        private val TRON = Regex("(?<![A-Za-z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![A-Za-z0-9])")
    }
}

/** IBAN syntax and mod-97 check. AE IBANs must pass the check; other known countries are accepted syntactically. */
object Iban {
    private val LENGTHS: Map<String, Int> = mapOf(
        "AE" to 23, "GB" to 22, "SA" to 24, "EG" to 29, "JO" to 30, "KW" to 30, "QA" to 29, "BH" to 22, "LB" to 28,
        "PK" to 24, "TR" to 26, "DE" to 22, "FR" to 27, "ES" to 24, "IT" to 27, "NL" to 18, "BE" to 16, "CH" to 21,
        "AT" to 20, "SE" to 24, "NO" to 15, "DK" to 18, "FI" to 18, "PL" to 28, "CZ" to 24, "IE" to 22, "PT" to 25,
        "GR" to 27, "RO" to 24, "HU" to 28, "BG" to 22, "HR" to 21, "LT" to 20, "LV" to 21, "EE" to 20, "MT" to 31,
        "CY" to 28, "LU" to 20, "SK" to 24, "SI" to 19, "IS" to 26, "MC" to 27, "GE" to 22, "AZ" to 28, "KZ" to 20,
        "MD" to 24, "UA" to 29, "BR" to 29, "IL" to 23, "MU" to 30, "TN" to 24, "MR" to 27, "DO" to 28, "CR" to 22,
        "GT" to 28, "SV" to 28, "IQ" to 23, "LY" to 25, "SD" to 18, "PS" to 29, "LI" to 21, "SM" to 27, "MK" to 19,
        "ME" to 22, "RS" to 22, "BA" to 20, "AL" to 28, "BY" to 28, "XK" to 20, "VG" to 24, "TL" to 23, "ST" to 25,
        "SC" to 31, "LC" to 32, "GI" to 23, "GL" to 18, "FO" to 18, "RU" to 33, "VA" to 22, "AD" to 24,
    )

    /** Compacts a candidate (spaces/hyphens removed, upper case) and validates it; null when it is not an IBAN. */
    fun normalise(candidate: String): String? {
        val compact = candidate.filter { it.isLetterOrDigit() }.uppercase()
        if (compact.length < 15) return null
        val country = compact.substring(0, 2)
        val expected = LENGTHS[country] ?: return null
        if (compact.length < expected) return null
        val iban = compact.substring(0, expected)
        if (!iban.substring(2, 4).all { it.isDigit() }) return null
        if (iban.substring(4).any { !it.isLetterOrDigit() }) return null
        val valid = mod97(iban)
        if (country == "AE" && !valid) return null
        if (country == "AE" && !iban.substring(4).all { it.isDigit() }) return null
        return iban
    }

    fun mod97(iban: String): Boolean {
        val rearranged = iban.substring(4) + iban.substring(0, 4)
        var remainder = 0
        for (ch in rearranged) {
            val v = if (ch.isDigit()) ch - '0' else ch.uppercaseChar() - 'A' + 10
            remainder = if (v >= 10) (remainder * 100 + v) % 97 else (remainder * 10 + v) % 97
        }
        return remainder == 1
    }
}
