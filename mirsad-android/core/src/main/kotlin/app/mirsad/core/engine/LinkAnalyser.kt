package app.mirsad.core.engine

import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.ReasonCodes

/** A URL found in the text. [registrableDomain] = last label + public suffix (e.g. adcb.com, moi.gov.ae). */
data class ExtractedLink(
    val raw: String,
    /** "http", "https" or null when the text had no scheme. */
    val scheme: String?,
    val host: String,
    val registrableDomain: String,
) {
    val isMessengerHandle: Boolean get() = registrableDomain in HANDLE_DOMAINS

    companion object {
        val HANDLE_DOMAINS = setOf("wa.me", "t.me", "telegram.me", "whatsapp.com")
    }
}

/**
 * Finds URLs (with or without scheme, incl. www. and bare domains with a path or a known TLD),
 * resolves registrable domains and produces the LINK_* reasons.
 */
class LinkAnalyser(private val rules: RuleSet, private val lexicon: Lexicon) {

    fun extract(normalisedText: String): List<ExtractedLink> {
        if (normalisedText.isEmpty()) return emptyList()
        val out = LinkedHashMap<String, ExtractedLink>()
        for (m in SCHEMED.findAll(normalisedText)) {
            val raw = trimTrailing(m.value)
            parse(raw)?.let { out.putIfAbsent(it.raw, it) }
        }
        for (m in BARE.findAll(normalisedText)) {
            val raw = trimTrailing(m.value)
            if (out.keys.any { it.contains(raw) }) continue
            val tld = m.groupValues[1].substringAfterLast('.')
            val hasPath = m.groupValues[2].isNotEmpty()
            if (!hasPath && tld !in KNOWN_TLDS && tld !in rules.highRiskTlds) continue
            parse(raw)?.let { out.putIfAbsent(it.raw, it) }
        }
        return out.values.toList()
    }

    fun isOfficial(link: ExtractedLink): Boolean = lexicon.isOfficial(link.registrableDomain)

    /** Link reasons for the whole message, merged per code. */
    fun analyse(links: List<ExtractedLink>, context: EngineContext, bag: ReasonBag) {
        for (link in links) {
            if (link.isMessengerHandle) continue
            val domain = link.registrableDomain
            if (domain in context.blockedDomains) {
                bag.add(ReasonCodes.LINK_BLOCKLISTED_DOMAIN, rules.weight(ReasonCodes.LINK_BLOCKLISTED_DOMAIN), domain, true)
            }
            if (lexicon.isOfficial(domain)) {
                bag.add(ReasonCodes.LINK_PRESENT, rules.weight("LINK_OFFICIAL"), "official:$domain", false)
                continue
            }
            bag.add(ReasonCodes.LINK_PRESENT, rules.weight(ReasonCodes.LINK_PRESENT), domain, false)
            if (domain in rules.shorteners || link.host in rules.shorteners) {
                bag.add(ReasonCodes.LINK_SHORTENER, rules.weight(ReasonCodes.LINK_SHORTENER), domain, false)
            }
            if (IPV4.matches(link.host)) {
                bag.add(ReasonCodes.LINK_IP_HOST, rules.weight(ReasonCodes.LINK_IP_HOST), link.host, false)
            }
            if (link.host.split('.').any { it.startsWith("xn--") } || link.host.any { it.code > 127 }) {
                bag.add(ReasonCodes.LINK_PUNYCODE_OR_MIXED_SCRIPT, rules.weight(ReasonCodes.LINK_PUNYCODE_OR_MIXED_SCRIPT), link.host, false)
            }
            if (link.scheme == "http") {
                bag.add(ReasonCodes.LINK_PLAIN_HTTP, rules.weight(ReasonCodes.LINK_PLAIN_HTTP), domain, false)
            }
            val tld = domain.substringAfterLast('.')
            if (tld in rules.highRiskTlds) {
                bag.add(ReasonCodes.LINK_HIGH_RISK_TLD, rules.weight(ReasonCodes.LINK_HIGH_RISK_TLD), domain, false)
            }
            lookalikeOf(domain)?.let { official ->
                bag.add(ReasonCodes.LINK_LOOKALIKE_OFFICIAL, rules.weight(ReasonCodes.LINK_LOOKALIKE_OFFICIAL), "$domain~$official", true)
            }
            brandInHost(link.host)?.let { entityId ->
                bag.add(ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL, rules.weight(ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL), "$entityId:${link.host}", true)
            }
        }
    }

    /** The official registrable domain this one imitates (Damerau-Levenshtein), or null. */
    fun lookalikeOf(registrableDomain: String): String? {
        if (IPV4.matches(registrableDomain)) return null
        var best: String? = null
        var bestDistance = Int.MAX_VALUE
        for (official in lexicon.officialDomains) {
            val sld = official.substringBefore('.')
            val max = if (sld.length <= 4) rules.lookalikeShortDomainMaxDistance else rules.lookalikeMaxDistance
            if (kotlin.math.abs(official.length - registrableDomain.length) > max) continue
            val d = damerauLevenshtein(registrableDomain, official, max)
            if (d in 1..max && d < bestDistance) { best = official; bestDistance = d }
        }
        return best
    }

    /** The entity whose brand token appears in a host that is not official, or null. */
    fun brandInHost(host: String): String? {
        val labels = host.split('.', '-').filter { it.isNotEmpty() }
        val squashed = host.replace(".", "").replace("-", "")
        for ((token, entityId) in lexicon.brandTokens) {
            val hit = if (token.length >= rules.brandSubstringMinLength) {
                squashed.contains(token.replace("-", ""))
            } else {
                token in labels
            }
            if (hit) return entityId
        }
        return null
    }

    private fun parse(raw: String): ExtractedLink? {
        var rest = raw
        var scheme: String? = null
        val schemeEnd = rest.indexOf("://")
        if (schemeEnd in 1..8) {
            scheme = rest.substring(0, schemeEnd).lowercase()
            rest = rest.substring(schemeEnd + 3)
        }
        val authorityEnd = rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it }
        var authority = rest.substring(0, authorityEnd)
        val at = authority.lastIndexOf('@')
        if (at >= 0) authority = authority.substring(at + 1)
        val host = authority.substringBefore(':').trimEnd('.').lowercase()
        if (host.isEmpty() || !host.contains('.')) return null
        if (host.any { it == ' ' }) return null
        return ExtractedLink(raw, scheme, host, registrableDomain(host))
    }

    companion object {
        private val SCHEMED = Regex("(?i)\\b(?:https?://|www\\.)[^\\s<>\"'،؛«»]+")
        private val BARE = Regex("(?<![\\w@.\\-/])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24})(?::\\d{2,5})?(/[^\\s<>\"'،؛«»]*)?")
        private val IPV4 = Regex("\\d{1,3}(?:\\.\\d{1,3}){3}")
        private const val TRAILING = ".,;:!?)]}>'\"»،؛"

        val KNOWN_TLDS: Set<String> = setOf(
            "com", "net", "org", "ae", "info", "biz", "io", "co", "me", "ly", "gd", "gy", "cc", "tv", "app", "dev",
            "example", "abudhabi", "dubai", "sa", "eg", "uk", "in", "br", "us", "ru", "de", "fr", "it", "es", "nl",
            "ch", "se", "no", "dk", "fi", "pl", "tr", "pk", "ph", "my", "sg", "id", "th", "vn", "cn", "jp", "kr",
            "au", "nz", "za", "ng", "ke", "qa", "kw", "bh", "om", "jo", "lb", "iq", "ir", "ps", "ma", "dz", "tn",
            "sd", "ye", "sy", "at", "be", "pt", "ie", "gr", "cz", "ro", "hu", "ua", "il", "mx", "ar", "cl", "pe",
            "ca", "eu", "asia", "xyz", "top", "click", "link", "icu", "buzz", "cfd", "sbs", "rest", "zip", "mov",
            "tk", "ml", "ga", "cf", "gq", "pw", "cam", "lol", "live", "online", "site", "shop", "store", "vip",
            "fun", "work", "world", "today", "news", "page", "web", "digital", "cloud", "network", "services",
        )

        /** Compact public-suffix list: two-label suffixes whose registrable domain has three labels. */
        val MULTI_PART_SUFFIXES: Set<String> = setOf(
            "gov.ae", "ac.ae", "co.ae", "net.ae", "org.ae", "sch.ae", "mil.ae",
            "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "nhs.uk", "net.uk",
            "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "asn.au",
            "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa", "med.sa", "sch.sa", "pub.sa",
            "com.eg", "net.eg", "org.eg", "gov.eg", "edu.eg", "sci.eg",
            "co.in", "net.in", "org.in", "gov.in", "ac.in", "firm.in", "gen.in", "ind.in", "nic.in", "res.in", "edu.in",
            "com.br", "net.br", "org.br", "gov.br", "edu.br",
            "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
            "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk",
            "co.za", "org.za", "net.za", "gov.za", "ac.za",
            "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
            "co.kr", "or.kr", "ne.kr", "go.kr",
            "co.nz", "net.nz", "org.nz", "govt.nz",
            "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
            "com.my", "net.my", "org.my", "gov.my", "edu.my",
            "com.ph", "net.ph", "org.ph", "gov.ph",
            "com.bd", "net.bd", "org.bd", "gov.bd",
            "com.lb", "net.lb", "org.lb", "gov.lb", "edu.lb",
            "com.jo", "net.jo", "org.jo", "gov.jo", "edu.jo",
            "com.kw", "net.kw", "org.kw", "gov.kw", "edu.kw",
            "com.qa", "net.qa", "org.qa", "gov.qa", "edu.qa",
            "com.bh", "net.bh", "org.bh", "gov.bh", "edu.bh",
            "com.om", "net.om", "org.om", "gov.om", "edu.om",
            "co.il", "org.il", "net.il", "gov.il", "ac.il",
            "com.mx", "org.mx", "gob.mx", "edu.mx",
            "com.ar", "net.ar", "org.ar", "gob.ar",
            "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
            "com.hk", "net.hk", "org.hk", "gov.hk", "edu.hk",
            "com.tw", "net.tw", "org.tw", "gov.tw",
            "com.vn", "net.vn", "org.vn", "gov.vn",
            "co.id", "or.id", "go.id", "ac.id",
            "co.th", "or.th", "go.th", "ac.th",
            "com.ng", "net.ng", "org.ng", "gov.ng",
            "com.gh", "org.gh", "gov.gh",
            "co.ke", "or.ke", "go.ke", "ac.ke",
            "com.ua", "net.ua", "org.ua", "gov.ua",
            "com.co", "net.co", "org.co", "gov.co",
            "com.pe", "com.cl", "com.ve", "com.ec", "com.uy", "com.py", "com.bo",
            "com.ma", "net.ma", "org.ma", "gov.ma",
            "com.dz", "com.tn", "com.ly", "com.sd", "com.ye", "com.sy", "com.iq", "com.ir", "com.ps",
            "com.np", "com.lk", "com.mm", "com.kh",
            "com.et", "com.tz", "co.tz", "co.ug", "com.zm", "co.zw", "co.mz",
            "com.pl", "com.pt", "com.es", "com.ru", "com.de",
        )

        fun registrableDomain(host: String): String {
            if (IPV4.matches(host)) return host
            val labels = host.split('.').filter { it.isNotEmpty() }
            if (labels.size <= 2) return labels.joinToString(".")
            val lastTwo = labels[labels.size - 2] + "." + labels[labels.size - 1]
            return if (lastTwo in MULTI_PART_SUFFIXES && labels.size >= 3) {
                labels[labels.size - 3] + "." + lastTwo
            } else {
                lastTwo
            }
        }

        private fun trimTrailing(s: String): String {
            var end = s.length
            while (end > 0 && TRAILING.indexOf(s[end - 1]) >= 0) end--
            var out = s.substring(0, end)
            // a closing parenthesis belongs to the prose unless the URL opened one
            while (out.endsWith(")") && out.count { it == '(' } < out.count { it == ')' }) out = out.dropLast(1)
            return out
        }

        /** Optimal string alignment (restricted Damerau-Levenshtein) distance with an early exit above [max]. */
        fun damerauLevenshtein(a: String, b: String, max: Int = Int.MAX_VALUE): Int {
            if (a == b) return 0
            if (kotlin.math.abs(a.length - b.length) > max) return max + 1
            val n = a.length
            val m = b.length
            if (n == 0) return m
            if (m == 0) return n
            var prev2: IntArray? = null
            var prev = IntArray(m + 1) { it }
            var cur = IntArray(m + 1)
            for (i in 1..n) {
                cur[0] = i
                var rowMin = cur[0]
                for (j in 1..m) {
                    val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                    var v = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
                    if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) {
                        v = minOf(v, prev2!![j - 2] + 1)
                    }
                    cur[j] = v
                    if (v < rowMin) rowMin = v
                }
                if (rowMin > max) return max + 1
                val tmp = prev2 ?: IntArray(m + 1)
                prev2 = prev
                prev = cur
                cur = tmp
            }
            return prev[m]
        }
    }
}
