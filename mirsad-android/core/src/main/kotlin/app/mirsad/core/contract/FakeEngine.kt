package app.mirsad.core.contract

/**
 * Placeholder engine so every workstream can compile and run the app before the real engine lands.
 * Replaced by MirsadEngineFactory.create() once workstream A delivers. Keyword-only, deliberately naive.
 */
class FakeEngine(private val classifier: Classifier = NoopClassifier) : ScamEngine {
    override fun analyse(event: Event, context: EngineContext): Verdict {
        val start = System.nanoTime()
        val text = event.text ?: ""
        val lower = text.lowercase()
        val reasons = mutableListOf<Reason>()
        val artifacts = mutableListOf<Artifact>()

        if (event.contentHidden) {
            return Verdict(0.0, Level.ALLOW, listOf(Reason(ReasonCodes.CONTENT_HIDDEN, 0.0)), emptyList(), ZERO_FP, elapsed(start))
        }
        val senderKey = event.sender.trim().lowercase()
        if (context.allowedSenders.any { it.lowercase() == senderKey }) {
            return Verdict(0.0, Level.ALLOW, listOf(Reason(ReasonCodes.SENDER_ALLOWLISTED, -1.0)), emptyList(), ZERO_FP, elapsed(start))
        }
        if (context.blockedSenders.any { it.lowercase() == senderKey }) {
            reasons += Reason(ReasonCodes.SENDER_BLOCKLISTED, 0.9, hard = true)
        }
        if (event.channel == Channel.CALL && context.recentlyHeldNumbers.contains(event.sender)) {
            reasons += Reason(ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE, 0.9, hard = true)
        }
        URL_REGEX.findAll(text).forEach { m ->
            val url = m.value
            artifacts += Artifact(ArtifactType.URL, url)
            val host = url.substringAfter("://").substringBefore("/").lowercase()
            artifacts += Artifact(ArtifactType.DOMAIN, host)
            if (url.startsWith("http://")) reasons += Reason(ReasonCodes.LINK_PLAIN_HTTP, 0.3, host)
            if (host.contains("example")) reasons += Reason(ReasonCodes.LINK_LOOKALIKE_OFFICIAL, 0.6, host, hard = true)
        }
        if (listOf("otp", "pin", "cvv", "password", "رمز").any { lower.contains(it) } &&
            listOf("share", "send", "أرسل", "ارسل").any { lower.contains(it) }
        ) {
            reasons += Reason(ReasonCodes.CONTENT_CREDENTIAL_REQUEST, 0.7, hard = true)
        }
        if (listOf("within 24 hours", "today", "immediately", "فوراً", "خلال 24").any { lower.contains(it) }) {
            reasons += Reason(ReasonCodes.CONTENT_URGENCY, 0.3)
        }
        if (listOf("suspended", "blocked", "fine", "تعليق", "مخالفة").any { lower.contains(it) }) {
            reasons += Reason(ReasonCodes.CONTENT_THREAT, 0.3)
        }
        if (listOf("prize", "won", "ربحت", "جائزة").any { lower.contains(it) }) reasons += Reason(ReasonCodes.CONTENT_PRIZE, 0.4)
        if (listOf("anydesk", "teamviewer").any { lower.contains(it) }) reasons += Reason(ReasonCodes.CONTENT_REMOTE_ACCESS_APP, 0.7, hard = true)

        val modelScore = classifier.scoreScam(lower)
        if (modelScore > 0.0) reasons += Reason(ReasonCodes.MODEL_SCORE, modelScore)

        val raw = reasons.sumOf { it.weight }
        val score = (1.0 - Math.exp(-raw * 1.6)).coerceIn(0.0, 1.0)
        val hasHard = reasons.any { it.hard }
        val level = when {
            event.senderLooksLikeContact -> if (score >= 0.5) Level.WARN else Level.ALLOW
            score >= 0.6 && hasHard -> Level.HOLD
            score >= 0.4 -> Level.WARN
            else -> Level.ALLOW
        }
        return Verdict(
            score = score,
            level = level,
            reasons = reasons,
            artifacts = artifacts,
            fingerprint = fakeFingerprint(lower),
            latencyMs = elapsed(start),
            language = if (text.any { it in '؀'..'ۿ' }) Language.AR else Language.EN,
            modelVersion = classifier.modelVersion,
            rulesVersion = "fake",
        )
    }

    private fun elapsed(startNanos: Long) = (System.nanoTime() - startNanos) / 1_000_000

    private fun fakeFingerprint(text: String): String {
        if (text.isBlank()) return ZERO_FP
        var h = 1469598103934665603uL
        for (c in text.replace(Regex("[0-9]"), "#")) {
            h = (h xor c.code.toULong()) * 1099511628211uL
        }
        return h.toString(16).padStart(16, '0')
    }

    companion object {
        const val ZERO_FP = "0000000000000000"
        private val URL_REGEX = Regex("""(?i)\b(?:https?://|www\.)[^\s<>"']+""")
    }
}
