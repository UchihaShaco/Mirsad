package app.mirsad.core.engine

import app.mirsad.core.contract.Level
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.Sensitivity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ScorerTest {
    private val rules = RuleSet.loadFromResources()
    private val scorer = Scorer(rules)

    @Test
    fun `rules file loaded with a version and thresholds`() {
        assertEquals("1.0.0", rules.version)
        assertEquals(0.45, rules.thresholds(Sensitivity.BALANCED).warn)
        assertEquals(0.65, rules.thresholds(Sensitivity.BALANCED).hold)
        assertEquals(0.60, rules.thresholds(Sensitivity.RELAXED).warn)
        assertEquals(0.80, rules.thresholds(Sensitivity.RELAXED).hold)
        assertEquals(0.35, rules.thresholds(Sensitivity.STRICT).warn)
        assertEquals(0.55, rules.thresholds(Sensitivity.STRICT).hold)
        assertTrue(rules.contentRules.isNotEmpty())
        assertTrue(rules.credentialRequest.isNotEmpty())
    }

    @Test
    fun `score is monotone and bounded`() {
        val soft = listOf(Reason(ReasonCodes.CONTENT_URGENCY, 0.2))
        val more = soft + Reason(ReasonCodes.CONTENT_THREAT, 0.3)
        val hard = more + Reason(ReasonCodes.CONTENT_CREDENTIAL_REQUEST, 0.7, hard = true)
        assertEquals(0.0, scorer.score(emptyList()))
        assertTrue(scorer.score(soft) < scorer.score(more))
        assertTrue(scorer.score(more) < scorer.score(hard))
        assertTrue(scorer.score(hard) <= 1.0)
        assertEquals(0.0, scorer.score(listOf(Reason(ReasonCodes.SENDER_OTP_FROM_ALPHANUMERIC, -0.8), Reason(ReasonCodes.CONTENT_URGENCY, 0.2))))
    }

    @Test
    fun `one soft reason stays allow and two medium reasons warn without hold`() {
        val one = scorer.score(listOf(Reason(ReasonCodes.CONTENT_PRIZE, 0.38)))
        assertEquals(Level.ALLOW, scorer.level(one, false, Sensitivity.BALANCED))
        assertEquals(Level.WARN, scorer.level(one, false, Sensitivity.STRICT))
        val two = scorer.score(listOf(Reason(ReasonCodes.CONTENT_PRIZE, 0.38), Reason(ReasonCodes.CONTENT_JOB_OFFER, 0.38), Reason(ReasonCodes.CONTENT_THREAT, 0.3)))
        assertTrue(two >= 0.65, "score $two")
        assertEquals(Level.WARN, scorer.level(two, false, Sensitivity.BALANCED), "no hard reason: never HOLD")
        assertEquals(Level.HOLD, scorer.level(two, true, Sensitivity.BALANCED))
    }

    @Test
    fun `hold needs threshold and hard reason per sensitivity`() {
        val reasons = listOf(Reason(ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL, 0.6, hard = true), Reason(ReasonCodes.CONTENT_URGENCY, 0.2))
        val s = scorer.score(reasons)
        assertEquals(Level.HOLD, scorer.level(s, true, Sensitivity.BALANCED))
        assertEquals(Level.HOLD, scorer.level(s, true, Sensitivity.STRICT))
        assertEquals(Level.WARN, scorer.level(s, true, Sensitivity.RELAXED), "score $s below relaxed hold 0.80")
    }

    @Test
    fun `classifier alone can reach warn but never hold`() {
        val only = listOf(Reason(ReasonCodes.MODEL_SCORE, 1.0))
        val s = scorer.score(only)
        assertTrue(s <= rules.modelWeight + 1e-9)
        assertEquals(Level.WARN, scorer.level(s, false, Sensitivity.BALANCED))
        assertTrue(scorer.level(s, false, Sensitivity.RELAXED) != Level.HOLD)
        assertEquals(0.0, scorer.rulesScore(only), "model score is not part of the rules sum")
    }

    @Test
    fun `reason bag merges duplicates keeping max weight and hardness`() {
        val bag = ReasonBag()
        bag.add(ReasonCodes.CONTENT_CREDENTIAL_REQUEST, 0.2, "update-via-link", false)
        bag.add(ReasonCodes.CONTENT_CREDENTIAL_REQUEST, 0.7, "request", true)
        bag.add(ReasonCodes.CONTENT_URGENCY, 0.1, "today")
        bag.add(ReasonCodes.CONTENT_URGENCY, 0.2)
        val cred = bag.get(ReasonCodes.CONTENT_CREDENTIAL_REQUEST)!!
        assertEquals(0.7, cred.weight)
        assertTrue(cred.hard)
        assertEquals("update-via-link", cred.detail)
        assertEquals(0.2, bag.get(ReasonCodes.CONTENT_URGENCY)!!.weight)
        assertEquals(2, bag.reasons.size)
    }
}
