package app.mirsad.core.engine

import app.mirsad.core.contract.Artifact
import app.mirsad.core.contract.ArtifactType
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Classifier
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Language
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.NoopClassifier
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.ScamEngine
import app.mirsad.core.contract.Verdict

/**
 * Stage 1 (rules + reputation) and the stage 2 gate. Pure Kotlin, immutable after construction,
 * safe to call from any thread, never throws (any failure yields ALLOW with ENGINE_ERROR).
 */
class MirsadEngine(
    private val classifier: Classifier,
    private val rules: RuleSet,
    private val lexicon: Lexicon,
) : ScamEngine {
    private val normaliser = TextNormaliser(rules.arabizi)
    private val linkAnalyser = LinkAnalyser(rules, lexicon)
    private val artifactExtractor = ArtifactExtractor()
    private val scorer = Scorer(rules)

    val rulesVersion: String get() = rules.version

    override fun analyse(event: Event, context: EngineContext): Verdict {
        val start = System.nanoTime()
        return try {
            analyseOrThrow(event, context, start)
        } catch (t: Throwable) {
            Verdict(
                score = 0.0,
                level = Level.ALLOW,
                reasons = listOf(Reason(ReasonCodes.ENGINE_ERROR, 0.0, t.javaClass.simpleName)),
                artifacts = emptyList(),
                fingerprint = SimHash.ZERO,
                latencyMs = elapsedMs(start),
                language = Language.UNKNOWN,
                modelVersion = "none",
                rulesVersion = rules.version,
            )
        }
    }

    // ------------------------------------------------------------------------------------

    private enum class SenderKind { NUMBER, ALPHANUMERIC, CONTACT, UNKNOWN }

    private class SenderInfo(val kind: SenderKind, val raw: String, val e164: String?, val key: String)

    private fun analyseOrThrow(event: Event, context: EngineContext, start: Long): Verdict {
        if (event.contentHidden) {
            return verdict(0.0, Level.ALLOW, listOf(Reason(ReasonCodes.CONTENT_HIDDEN, 0.0)), emptyList(), SimHash.ZERO, Language.UNKNOWN, start)
        }
        val text = event.text ?: ""
        val norm = normaliser.normalise(text)
        val language = normaliser.detectLanguage(norm)
        val fingerprint = SimHash.fingerprint(norm)
        val sender = senderInfo(event)
        val links = linkAnalyser.extract(norm)
        val artifacts = artifactExtractor.extract(text, norm, links)

        if (inList(context.allowedSenders, sender)) {
            val reason = Reason(ReasonCodes.SENDER_ALLOWLISTED, rules.weight(ReasonCodes.SENDER_ALLOWLISTED), null, false)
            return verdict(0.0, Level.ALLOW, listOf(reason), artifacts, fingerprint, language, start)
        }

        val bag = ReasonBag()
        val entities = lexicon.findEntities(norm)
        val handles = artifacts.filter { it.type == ArtifactType.HANDLE }
        val hasAnyLink = links.isNotEmpty() || handles.isNotEmpty()
        val hasRiskyLink = handles.isNotEmpty() || links.any { !it.isMessengerHandle && !linkAnalyser.isOfficial(it) }

        senderRules(event, sender, entities, context, bag)
        linkAnalyser.analyse(links, context, bag)
        contentRules(norm, artifacts, hasRiskyLink, bag)
        impersonationRule(sender, entities, hasRiskyLink, bag)

        // Legit one-time code from an alphanumeric sender: strong safe signal, never HOLD.
        val otpLegit = sender.kind == SenderKind.ALPHANUMERIC && !hasAnyLink && rules.otpMessage.any { it.containsMatchIn(norm) }
        if (otpLegit && !bag.contains(ReasonCodes.CONTENT_CREDENTIAL_REQUEST) && !bag.contains(ReasonCodes.CONTENT_OTP_REQUEST)) {
            bag.add(ReasonCodes.SENDER_OTP_FROM_ALPHANUMERIC, rules.weight(ReasonCodes.SENDER_OTP_FROM_ALPHANUMERIC))
        }

        if (fingerprint != SimHash.ZERO && fingerprint in context.blockedFingerprints) {
            bag.add(ReasonCodes.FINGERPRINT_BLOCKLISTED, rules.weight(ReasonCodes.FINGERPRINT_BLOCKLISTED), null, true)
        }
        val knownGood = fingerprint != SimHash.ZERO && fingerprint in context.knownGoodFingerprints
        if (knownGood) bag.add(ReasonCodes.FINGERPRINT_KNOWN_GOOD, rules.weight(ReasonCodes.FINGERPRINT_KNOWN_GOOD))
        if (sender.kind == SenderKind.CONTACT) {
            bag.add(ReasonCodes.SENDER_LOOKS_LIKE_CONTACT, rules.weight(ReasonCodes.SENDER_LOOKS_LIKE_CONTACT))
        }

        var modelVersion = "none"
        if (!context.stageOneOnly && norm.isNotEmpty()) {
            modelVersion = classifier.modelVersion
            val p = runCatching { classifier.scoreScam(norm) }.getOrDefault(0.0)
            if (p.isFinite() && p > 0.0) bag.add(ReasonCodes.MODEL_SCORE, p.coerceIn(0.0, 1.0))
        }

        val reasons = bag.reasons
        val score = scorer.score(reasons)
        var level = scorer.level(score, bag.hasHard, context.sensitivity)

        val blocklistHard = bag.contains(ReasonCodes.SENDER_BLOCKLISTED) ||
            bag.contains(ReasonCodes.LINK_BLOCKLISTED_DOMAIN) || bag.contains(ReasonCodes.FINGERPRINT_BLOCKLISTED)
        if (knownGood) level = if (blocklistHard) minOf(level, Level.WARN) else Level.ALLOW
        if (sender.kind == SenderKind.CONTACT) level = minOf(level, Level.WARN)
        if (otpLegit) level = minOf(level, Level.WARN)
        if (event.channel == Channel.CALL &&
            !bag.contains(ReasonCodes.SENDER_BLOCKLISTED) && !bag.contains(ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE)
        ) {
            level = minOf(level, Level.WARN)
        }
        return verdict(score, level, reasons, artifacts, fingerprint, language, start, modelVersion)
    }

    private fun senderInfo(event: Event): SenderInfo {
        val raw = event.sender.trim()
        val e164 = PhoneNumbers.toE164(raw)
        val key = e164 ?: raw.lowercase()
        val kind = when {
            event.senderLooksLikeContact -> SenderKind.CONTACT
            e164 != null -> SenderKind.NUMBER
            raw.isEmpty() -> SenderKind.UNKNOWN
            else -> SenderKind.ALPHANUMERIC
        }
        return SenderInfo(kind, raw, e164, key)
    }

    /** Case-insensitive on the normalised value; phone numbers compared in E.164. */
    private fun inList(set: Set<String>, sender: SenderInfo): Boolean {
        if (set.isEmpty()) return false
        if (sender.key in set || sender.raw in set || sender.raw.lowercase() in set) return true
        if (sender.e164 != null && sender.e164 in set) return true
        if (set.size <= 2000) return set.any { (PhoneNumbers.toE164(it) ?: it.trim().lowercase()) == sender.key }
        return false
    }

    private fun senderRules(event: Event, sender: SenderInfo, entities: List<Entity>, context: EngineContext, bag: ReasonBag) {
        if (inList(context.blockedSenders, sender)) {
            bag.add(ReasonCodes.SENDER_BLOCKLISTED, rules.weight(ReasonCodes.SENDER_BLOCKLISTED), null, true)
        }
        val e164 = sender.e164
        if (e164 != null && e164 in context.recentlyHeldNumbers) {
            bag.add(ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE, rules.weight(ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE), null, true)
        }
        val entityIds = entities.joinToString(",") { it.id }
        if (sender.kind == SenderKind.NUMBER && e164 != null && entities.isNotEmpty()) {
            bag.add(ReasonCodes.SENDER_PLAIN_NUMBER_CLAIMS_ENTITY, rules.weight(ReasonCodes.SENDER_PLAIN_NUMBER_CLAIMS_ENTITY), entityIds)
            if (!PhoneNumbers.isUae(e164)) {
                bag.add(ReasonCodes.SENDER_FOREIGN_CODE_UAE_ENTITY, rules.weight(ReasonCodes.SENDER_FOREIGN_CODE_UAE_ENTITY), countryPrefix(e164))
            }
        }
        if (event.channel == Channel.CALL && sender.kind == SenderKind.NUMBER && e164 != null && !PhoneNumbers.isUae(e164)) {
            bag.add(ReasonCodes.SENDER_INTERNATIONAL_CALL, rules.weight(ReasonCodes.SENDER_INTERNATIONAL_CALL), countryPrefix(e164))
            if (rules.oneRingPrefixes.any { e164.startsWith(it) }) {
                bag.add(ReasonCodes.SENDER_ONE_RING_PATTERN, rules.weight(ReasonCodes.SENDER_ONE_RING_PATTERN), countryPrefix(e164))
            }
        }
    }

    /** An entity is named and something does not add up: a non-official link, a foreign number, or a plain number applying pressure. */
    private fun impersonationRule(sender: SenderInfo, entities: List<Entity>, hasRiskyLink: Boolean, bag: ReasonBag) {
        if (entities.isEmpty()) return
        val foreign = sender.kind == SenderKind.NUMBER && sender.e164 != null && !PhoneNumbers.isUae(sender.e164)
        val pressure = PRESSURE_CODES.any { bag.contains(it) }
        val plainNumberPressure = sender.kind == SenderKind.NUMBER && pressure
        if (hasRiskyLink || foreign || plainNumberPressure) {
            bag.add(ReasonCodes.CONTENT_IMPERSONATES_ENTITY, rules.weight(ReasonCodes.CONTENT_IMPERSONATES_ENTITY), entities.joinToString(",") { it.id })
        }
    }

    private fun contentRules(norm: String, artifacts: List<Artifact>, hasRiskyLink: Boolean, bag: ReasonBag) {
        if (norm.isEmpty()) return
        for (rule in rules.contentRules) {
            if (!rule.matches(norm)) continue
            val spec = rule.spec
            val escalate = spec.hardWithLink && hasRiskyLink
            val weight = if (escalate) (spec.hardWeight ?: spec.weight) else spec.weight
            bag.add(spec.code, weight, spec.detail, spec.hard || escalate)
        }
        if (rules.credentialRequest.any { it.containsMatchIn(norm) }) {
            bag.add(ReasonCodes.CONTENT_CREDENTIAL_REQUEST, rules.weight(ReasonCodes.CONTENT_CREDENTIAL_REQUEST), "request", rules.hard(ReasonCodes.CONTENT_CREDENTIAL_REQUEST))
        }
        if (rules.otpRequest.any { it.containsMatchIn(norm) }) {
            bag.add(ReasonCodes.CONTENT_OTP_REQUEST, rules.weight(ReasonCodes.CONTENT_OTP_REQUEST), null, rules.hard(ReasonCodes.CONTENT_OTP_REQUEST))
        }
        val smallAmount = rules.smallFeeAmounts.asSequence()
            .flatMap { it.findAll(norm) }
            .mapNotNull { parseAmount(it.groupValues[1]) }
            .any { it < rules.smallFeeMaxAmount }
        if (smallAmount && rules.smallFeeKeywords?.containsMatchIn(norm) == true) {
            val code = ReasonCodes.CONTENT_SMALL_FEE_LINK
            if (hasRiskyLink) bag.add(code, rules.hardWeight(code), "link", true) else bag.add(code, rules.weight(code), null, false)
        }
        if (rules.paymentRequest.any { it.containsMatchIn(norm) }) {
            val code = ReasonCodes.CONTENT_PAYMENT_REQUEST
            val hasAccount = artifacts.any { it.type == ArtifactType.IBAN || it.type == ArtifactType.WALLET }
            if (hasAccount) bag.add(code, rules.hardWeight(code), "iban-or-wallet", true) else bag.add(code, rules.weight(code), null, false)
        }
    }

    private fun verdict(
        score: Double, level: Level, reasons: List<Reason>, artifacts: List<Artifact>,
        fingerprint: String, language: Language, start: Long, modelVersion: String = "none",
    ) = Verdict(
        score = score.coerceIn(0.0, 1.0),
        level = level,
        reasons = reasons,
        artifacts = artifacts,
        fingerprint = fingerprint,
        latencyMs = elapsedMs(start),
        language = language,
        modelVersion = modelVersion,
        rulesVersion = rules.version,
    )

    private fun elapsedMs(startNanos: Long): Long = (System.nanoTime() - startNanos) / 1_000_000

    companion object {
        private val PRESSURE_CODES = listOf(
            ReasonCodes.CONTENT_THREAT, ReasonCodes.CONTENT_URGENCY, ReasonCodes.CONTENT_CREDENTIAL_REQUEST,
            ReasonCodes.CONTENT_OTP_REQUEST, ReasonCodes.CONTENT_PRIZE, ReasonCodes.CONTENT_SMALL_FEE_LINK,
            ReasonCodes.CONTENT_PAYMENT_REQUEST, ReasonCodes.CONTENT_REMOTE_ACCESS_APP,
        )
        private val TWO_DIGIT_CODES = setOf(
            "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
            "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84",
            "86", "90", "91", "92", "93", "94", "95", "98",
        )

        /** "+971", "+44", "+1" ... for reason details. */
        fun countryPrefix(e164: String): String {
            if (!e164.startsWith("+")) return e164.take(3)
            val d = e164.substring(1)
            return when {
                d.startsWith("1") || d.startsWith("7") -> "+" + d.take(1)
                d.take(2) in TWO_DIGIT_CODES -> "+" + d.take(2)
                else -> "+" + d.take(3)
            }
        }

        /** "3.50" → 3.5, "3,50" → 3.5, "2,000" → 2000, "1.000" → 1000. */
        fun parseAmount(s: String): Double? {
            val sep = s.indexOfAny(charArrayOf('.', ','))
            if (sep < 0) return s.toDoubleOrNull()
            val whole = s.substring(0, sep)
            val frac = s.substring(sep + 1)
            return if (frac.length == 3) (whole + frac).toDoubleOrNull() else "$whole.$frac".toDoubleOrNull()
        }

        private val shared: Lazy<Pair<RuleSet, Lexicon>> = lazy {
            val rules = RuleSet.loadFromResources()
            rules to Lexicon.loadFromResources(TextNormaliser(rules.arabizi))
        }

        /** Engine over the rules/lexicon assets on the classpath (loaded once, shared). Never throws. */
        fun create(classifier: Classifier = NoopClassifier): MirsadEngine {
            val (rules, lexicon) = runCatching { shared.value }.getOrElse {
                RuleSet(RulesFile(version = "load-error")) to Lexicon(LexiconFile(), OfficialDomainsFile())
            }
            return MirsadEngine(classifier, rules, lexicon)
        }
    }
}
