package app.mirsad.core.engine

import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.ReasonCodes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LinkAnalyserTest {
    private val rules = RuleSet.loadFromResources()
    private val normaliser = TextNormaliser(rules.arabizi)
    private val lexicon = Lexicon.loadFromResources(normaliser)
    private val analyser = LinkAnalyser(rules, lexicon)

    private fun codes(text: String, context: EngineContext = EngineContext()): Map<String, Boolean> {
        val bag = ReasonBag()
        analyser.analyse(analyser.extract(normaliser.normalise(text)), context, bag)
        return bag.reasons.associate { it.code to it.hard }
    }

    @Test
    fun `extracts urls with and without scheme`() {
        val links = analyser.extract(normaliser.normalise(
            "Pay here: http://emiratespost-ae.delivery-fee.example/pay, or www.adcb.com/login or bank-update.example/ae or noon.com today.",
        ))
        val hosts = links.map { it.host }
        assertEquals(listOf("emiratespost-ae.delivery-fee.example", "www.adcb.com", "bank-update.example", "noon.com"), hosts)
        assertEquals("http", links[0].scheme)
        assertEquals("delivery-fee.example", links[0].registrableDomain)
        assertEquals("adcb.com", links[1].registrableDomain)
        assertEquals("http://emiratespost-ae.delivery-fee.example/pay", links[0].raw)
    }

    @Test
    fun `does not extract amounts or sentence ends as domains`() {
        val links = analyser.extract(normaliser.normalise("Your bill is AED 412.35, due on 15 Nov. Reply 1 to confirm. See you at 2.30 pm"))
        assertTrue(links.isEmpty(), "unexpected links: $links")
    }

    @Test
    fun `registrable domain handles multi-part suffixes`() {
        assertEquals("moi.gov.ae", LinkAnalyser.registrableDomain("services.moi.gov.ae"))
        assertEquals("example.co.uk", LinkAnalyser.registrableDomain("www.example.co.uk"))
        assertEquals("adcb.com", LinkAnalyser.registrableDomain("secure.login.adcb.com"))
        assertEquals("tamm.abudhabi", LinkAnalyser.registrableDomain("www.tamm.abudhabi"))
        assertEquals("10.0.0.1", LinkAnalyser.registrableDomain("10.0.0.1"))
    }

    @Test
    fun `flags shorteners ip hosts punycode http and risky tlds`() {
        assertTrue(codes("see bit.ly/abc123 now").containsKey(ReasonCodes.LINK_SHORTENER))
        assertTrue(codes("see http://192.168.1.10/login").containsKey(ReasonCodes.LINK_IP_HOST))
        assertTrue(codes("see http://xn--adcb-xyz.com/x").containsKey(ReasonCodes.LINK_PUNYCODE_OR_MIXED_SCRIPT))
        assertTrue(codes("see http://plain.example/x").containsKey(ReasonCodes.LINK_PLAIN_HTTP))
        assertFalse(codes("see https://plain.example/x").containsKey(ReasonCodes.LINK_PLAIN_HTTP))
        assertTrue(codes("see https://verify-account.top/x").containsKey(ReasonCodes.LINK_HIGH_RISK_TLD))
    }

    @Test
    fun `lookalike of an official domain is hard`() {
        assertEquals("adcb.com", analyser.lookalikeOf("adcb.co"))
        assertEquals("emiratesnbd.com", analyser.lookalikeOf("emiratesnbd.co"))
        assertNull(analyser.lookalikeOf("adcb.com"), "official domains are not lookalikes of themselves")
        assertNull(analyser.lookalikeOf("dewa.gov.ae"))
        assertNull(analyser.lookalikeOf("delivery-fee.example"))
        val c = codes("login at https://adcb.co/verify")
        assertEquals(true, c[ReasonCodes.LINK_LOOKALIKE_OFFICIAL])
    }

    @Test
    fun `brand token in a non-official host is hard`() {
        assertEquals("emiratespost", analyser.brandInHost("emiratespost-ae.delivery-fee.example"))
        assertEquals("adpolice", analyser.brandInHost("adpolice-fines.example"))
        assertEquals("salik", analyser.brandInHost("salik-recharge.example"))
        assertEquals("adcb", analyser.brandInHost("adcb.secure-login.example"))
        assertNull(analyser.brandInHost("noon.com"))
        assertEquals(true, codes("pay at http://dewa-bill.example")[ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL])
        assertEquals(true, codes("cancel at http://uaepass-cancel.example")[ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL])
    }

    @Test
    fun `official domain is a negative signal and nothing else fires`() {
        val bag = ReasonBag()
        analyser.analyse(analyser.extract("pay at https://www.dewa.gov.ae or https://icp.gov.ae/x"), EngineContext(), bag)
        assertEquals(1, bag.reasons.size)
        val r = bag.reasons.single()
        assertEquals(ReasonCodes.LINK_PRESENT, r.code)
        assertTrue(r.weight < 0)
        assertTrue(lexicon.isOfficial("anything.gov.ae"), "gov.ae suffix is official")
        assertFalse(lexicon.isOfficial("gov.ae.example"))
    }

    @Test
    fun `blocklisted registrable domain is hard`() {
        val c = codes("see https://pay.bad.example/x", EngineContext(blockedDomains = setOf("bad.example")))
        assertEquals(true, c[ReasonCodes.LINK_BLOCKLISTED_DOMAIN])
    }

    @Test
    fun `damerau levenshtein counts transpositions as one`() {
        assertEquals(1, LinkAnalyser.damerauLevenshtein("adcb.com", "acdb.com"))
        assertEquals(2, LinkAnalyser.damerauLevenshtein("salik.ae", "saliik.a"))
        assertEquals(0, LinkAnalyser.damerauLevenshtein("x", "x"))
        assertTrue(LinkAnalyser.damerauLevenshtein("abcdefgh", "zzzzzzzz", 2) > 2)
        assertNotNull(analyser.lookalikeOf("saIik.ae"))
    }
}
