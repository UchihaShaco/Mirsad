package app.mirsad.core.engine

import app.mirsad.core.contract.Level
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.Sensitivity
import kotlin.math.exp

/** Collects reasons and merges duplicates per code: max weight, hard if any is hard, first detail kept. */
class ReasonBag {
    private val map = LinkedHashMap<String, Reason>()

    fun add(code: String, weight: Double, detail: String? = null, hard: Boolean = false) {
        val w = weight.coerceIn(-1.0, 1.0)
        val existing = map[code]
        map[code] = if (existing == null) {
            Reason(code, w, detail, hard)
        } else {
            Reason(code, maxOf(existing.weight, w), existing.detail ?: detail, existing.hard || hard)
        }
    }

    fun add(reason: Reason) = add(reason.code, reason.weight, reason.detail, reason.hard)

    fun contains(code: String): Boolean = map.containsKey(code)
    fun remove(code: String) { map.remove(code) }
    fun get(code: String): Reason? = map[code]
    val reasons: List<Reason> get() = map.values.toList()
    val hasHard: Boolean get() = map.values.any { it.hard }
}

/**
 * Turns reasons into a score in [0, 1] and applies the HOLD gate.
 *
 * rulesScore = 1 - exp(-k * max(0, sum of weights))     (MODEL_SCORE excluded from the sum)
 * score      = 1 - (1 - rulesScore) * (1 - modelWeight * P(scam))
 * Monotone in every weight and in the model probability; the model alone tops out at modelWeight.
 */
class Scorer(private val rules: RuleSet) {

    fun rulesScore(reasons: List<Reason>): Double {
        val sum = reasons.filter { it.code != ReasonCodes.MODEL_SCORE }.sumOf { it.weight }
        if (sum <= 0.0) return 0.0
        return (1.0 - exp(-rules.k * sum)).coerceIn(0.0, 1.0)
    }

    fun combine(rulesScore: Double, modelScore: Double): Double {
        val m = modelScore.coerceIn(0.0, 1.0) * rules.modelWeight
        return (1.0 - (1.0 - rulesScore) * (1.0 - m)).coerceIn(0.0, 1.0)
    }

    fun score(reasons: List<Reason>): Double {
        val model = reasons.firstOrNull { it.code == ReasonCodes.MODEL_SCORE }?.weight ?: 0.0
        return combine(rulesScore(reasons), model)
    }

    /** Level from thresholds; HOLD needs the threshold and at least one hard reason. */
    fun level(score: Double, hasHard: Boolean, sensitivity: Sensitivity): Level {
        val t = rules.thresholds(sensitivity)
        return when {
            score >= t.hold && hasHard -> Level.HOLD
            score >= t.warn -> Level.WARN
            else -> Level.ALLOW
        }
    }
}
