package app.mirsad.core.engine

import app.mirsad.core.contract.Sensitivity
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// ----------------------------------------------------------------------------------------
// rules.json schema (version 1). Every field has a default so a partial file still loads.
// ----------------------------------------------------------------------------------------

@Serializable
data class RulesFile(
    val version: String = "unknown",
    val scoring: ScoringSpec = ScoringSpec(),
    val thresholds: Map<String, ThresholdSpec> = emptyMap(),
    val weights: Map<String, WeightSpec> = emptyMap(),
    val contentRules: List<ContentRuleSpec> = emptyList(),
    val credentialRequest: PatternGroupSpec = PatternGroupSpec(),
    val otpRequest: PatternGroupSpec = PatternGroupSpec(),
    val otpMessage: PatternGroupSpec = PatternGroupSpec(),
    val smallFee: SmallFeeSpec = SmallFeeSpec(),
    val paymentRequest: PatternGroupSpec = PatternGroupSpec(),
    val links: LinksSpec = LinksSpec(),
    val calls: CallsSpec = CallsSpec(),
    val arabizi: ArabiziSpec = ArabiziSpec(),
)

@Serializable
data class ScoringSpec(val k: Double = 1.5, val modelWeight: Double = 0.7)

@Serializable
data class ThresholdSpec(val warn: Double, val hold: Double)

@Serializable
data class WeightSpec(val weight: Double, val hard: Boolean = false, val hardWeight: Double? = null)

@Serializable
data class ContentRuleSpec(
    val code: String,
    val weight: Double,
    val hard: Boolean = false,
    /** Becomes hard (with [hardWeight]) when a non-official link or a messenger handle is present. */
    val hardWithLink: Boolean = false,
    val hardWeight: Double? = null,
    val detail: String? = null,
    val patterns: List<String> = emptyList(),
)

@Serializable
data class PatternGroupSpec(val patterns: List<String> = emptyList())

@Serializable
data class SmallFeeSpec(
    val maxAmount: Double = 50.0,
    val amountPatterns: List<String> = emptyList(),
    val keywordPattern: String = "",
)

@Serializable
data class LinksSpec(
    val shorteners: List<String> = emptyList(),
    val highRiskTlds: List<String> = emptyList(),
    val brandSubstringMinLength: Int = 5,
    val lookalikeMaxDistance: Int = 2,
    val lookalikeShortDomainMaxDistance: Int = 1,
)

@Serializable
data class CallsSpec(val oneRingPrefixes: List<String> = emptyList())

@Serializable
data class ArabiziSpec(val strong: List<String> = emptyList(), val weak: List<String> = emptyList())

// ----------------------------------------------------------------------------------------
// Compiled form. Immutable, so safe to share between threads.
// ----------------------------------------------------------------------------------------

class CompiledContentRule(val spec: ContentRuleSpec, val patterns: List<Regex>) {
    fun matches(text: String): Boolean = patterns.any { it.containsMatchIn(text) }
}

class Thresholds(val warn: Double, val hold: Double)

class RuleSet(val file: RulesFile) {
    val version: String get() = file.version
    val k: Double = file.scoring.k
    val modelWeight: Double = file.scoring.modelWeight.coerceIn(0.0, 1.0)

    private val thresholds: Map<Sensitivity, Thresholds> = Sensitivity.values().associateWith { s ->
        val spec = file.thresholds[s.name]
        if (spec != null) Thresholds(spec.warn, spec.hold) else DEFAULT_THRESHOLDS.getValue(s)
    }

    fun thresholds(sensitivity: Sensitivity): Thresholds = thresholds.getValue(sensitivity)

    fun weight(code: String): Double = file.weights[code]?.weight ?: 0.0
    fun hard(code: String): Boolean = file.weights[code]?.hard ?: false
    fun hardWeight(code: String): Double = file.weights[code]?.let { it.hardWeight ?: it.weight } ?: 0.0

    val contentRules: List<CompiledContentRule> = file.contentRules.map { CompiledContentRule(it, compileAll(it.patterns)) }
    val credentialRequest: List<Regex> = compileAll(file.credentialRequest.patterns)
    val otpRequest: List<Regex> = compileAll(file.otpRequest.patterns)
    val otpMessage: List<Regex> = compileAll(file.otpMessage.patterns)
    val paymentRequest: List<Regex> = compileAll(file.paymentRequest.patterns)
    val smallFeeAmounts: List<Regex> = compileAll(file.smallFee.amountPatterns)
    val smallFeeKeywords: Regex? = compile(file.smallFee.keywordPattern)
    val smallFeeMaxAmount: Double = file.smallFee.maxAmount

    val shorteners: Set<String> = file.links.shorteners.map { it.lowercase() }.toHashSet()
    val highRiskTlds: Set<String> = file.links.highRiskTlds.map { it.lowercase() }.toHashSet()
    val brandSubstringMinLength: Int = file.links.brandSubstringMinLength
    val lookalikeMaxDistance: Int = file.links.lookalikeMaxDistance
    val lookalikeShortDomainMaxDistance: Int = file.links.lookalikeShortDomainMaxDistance
    val oneRingPrefixes: List<String> = file.calls.oneRingPrefixes
    val arabizi: ArabiziLexicon = ArabiziLexicon(file.arabizi.strong, file.arabizi.weak)

    companion object {
        private val DEFAULT_THRESHOLDS = mapOf(
            Sensitivity.RELAXED to Thresholds(0.60, 0.80),
            Sensitivity.BALANCED to Thresholds(0.45, 0.65),
            Sensitivity.STRICT to Thresholds(0.35, 0.55),
        )
        val json = Json { ignoreUnknownKeys = true; isLenient = true }

        fun parse(text: String): RuleSet = RuleSet(json.decodeFromString(RulesFile.serializer(), text))

        /** Loads /rules.json from the classpath; a broken or missing file yields an empty rule set. */
        fun loadFromResources(): RuleSet {
            val text = runCatching { Resources.readText("/rules.json") }.getOrNull()
                ?: return RuleSet(RulesFile(version = "missing"))
            return runCatching { parse(text) }.getOrElse { RuleSet(RulesFile(version = "invalid")) }
        }

        private fun compileAll(patterns: List<String>): List<Regex> = patterns.mapNotNull { compile(it) }

        private fun compile(pattern: String): Regex? {
            if (pattern.isBlank()) return null
            return runCatching { Regex(pattern, setOf(RegexOption.IGNORE_CASE)) }.getOrNull()
        }
    }
}

internal object Resources {
    fun readText(path: String): String? =
        Resources::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }
}
