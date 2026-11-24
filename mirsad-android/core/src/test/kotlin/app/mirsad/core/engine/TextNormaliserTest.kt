package app.mirsad.core.engine

import app.mirsad.core.contract.Language
import kotlin.test.Test
import kotlin.test.assertEquals

class TextNormaliserTest {
    private val rules = RuleSet.loadFromResources()
    private val n = TextNormaliser(rules.arabizi)

    @Test
    fun `strips tashkeel and tatweel and unifies letters`() {
        assertEquals("فورا", n.normalise("فوراً"))
        assertEquals("مرحبا", n.normalise("مـــرحـبـا"))
        assertEquals("اخر فرصه", n.normalise("آخر فرصة"))
        assertEquals("احمد ابراهيم", n.normalise("أحمد إبراهيم"))
        assertEquals("علي", n.normalise("على"))
        assertEquals("مدينه", n.normalise("مدينة"))
    }

    @Test
    fun `maps arabic-indic and persian digits to ascii`() {
        assertEquals("خلال 24 ساعه", n.normalise("خلال ٢٤ ساعة"))
        assertEquals("رمز 482913", n.normalise("رمز ۴۸۲۹۱۳"))
    }

    @Test
    fun `lowercases and collapses whitespace`() {
        assertEquals("hello world http://x.example/pay", n.normalise("  Hello   WORLD\n\thttp://X.example/pay "))
        assertEquals("", n.normalise(null))
        assertEquals("", n.normalise("   "))
    }

    @Test
    fun `detects english arabic arabizi and unknown`() {
        assertEquals(Language.EN, n.detectLanguage(n.normalise("Your OTP is 482913 for a purchase of AED 120.00 at CARREFOUR.")))
        assertEquals(Language.AR, n.detectLanguage(n.normalise("رمز التحقق الخاص بك هو 771204. لا تشارك هذا الرمز مع أي شخص.")))
        assertEquals(Language.AR, n.detectLanguage(n.normalise("شرطة دبي: لديك مخالفة مرورية غير مدفوعة: http://dubaipolice-pay.example")))
        assertEquals(Language.LATIN_ARABIC, n.detectLanguage(n.normalise("yalla 7abibi, 3ala tool inshallah")))
        assertEquals(Language.LATIN_ARABIC, n.detectLanguage(n.normalise("yalla nel2a 3al 6 fel corniche? el jaw 7elo el yom.")))
        assertEquals(Language.LATIN_ARABIC, n.detectLanguage(n.normalise("ya akhi wallah")))
        assertEquals(Language.EN, n.detectLanguage(n.normalise("Are we still on for padel at 8? I booked court 3.")))
        assertEquals(Language.UNKNOWN, n.detectLanguage(n.normalise("12345 +971 50")))
        assertEquals(Language.UNKNOWN, n.detectLanguage(""))
    }
}
