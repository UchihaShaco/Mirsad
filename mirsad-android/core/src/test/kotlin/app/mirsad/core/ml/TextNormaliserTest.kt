package app.mirsad.core.ml

import kotlin.test.Test
import kotlin.test.assertEquals

class TextNormaliserTest {
    @Test
    fun `lowercases and collapses whitespace`() {
        assertEquals("hello world", normaliseForModel("  Hello \n\t World  "))
    }

    @Test
    fun `masks digit runs, urls and emails`() {
        assertEquals("pay aed #.# within # hours: <url> now", normaliseForModel("Pay AED 3.50 within 24 hours: http://emiratespost-ae.delivery-fee.example/pay now"))
        assertEquals("recharge at <url> or in the app", normaliseForModel("Recharge at salik.ae or in the app"))
        assertEquals("message <url> today", normaliseForModel("Message t.me/hr_uae_jobs_example today"))
        assertEquals("write to <email> please", normaliseForModel("Write to Help@Bank-Example.com please"))
        assertEquals("see <url> and <url>", normaliseForModel("See www.example.test/a and HTTPS://X.EXAMPLE"))
        assertEquals("iban ae# code", normaliseForModel("IBAN AE070331234567890123456 code"))
    }

    @Test
    fun `keeps decimals and times as masked digits, not urls`() {
        assertEquals("at #:# for aed #.# e.g. a.m.", normaliseForModel("At 09:30 for AED 412.35 e.g. a.m."))
    }

    @Test
    fun `normalises arabic letters, digits and punctuation`() {
        assertEquals("محمد", normaliseForModel("مُحَمَّد"))
        assertEquals("ااا", normaliseForModel("أإآ"))
        assertEquals("جائزه علي", normaliseForModel("جائزة على"))
        assertEquals("#", normaliseForModel("٠١٢٣٤٥٦٧٨٩"))
        assertEquals("# درهم", normaliseForModel("۵۰ درهم"))
        assertEquals("نعم, لا? تمام", normaliseForModel("نعم، لا؟ تمام"))
        assertEquals("مرحبا", normaliseForModel("مـــرحـــبا"))
    }

    @Test
    fun `drops zero width characters`() {
        assertEquals("otp #", normaliseForModel("OTP​ 48‍2913﻿"))
    }

    @Test
    fun `is idempotent on seeds, suite and edge cases`() {
        val samples = TestData.seeds.map { it.text } + TestData.legitSuite.map { it.text } + listOf(
            "", "   ", "http://a.example", "<url> <email> # #.#", "اَلْعَرَبِيَّةُ ١٢٣", "x@y.example ok", "9.30am A.M. e.g.",
        )
        for (s in samples) {
            val once = normaliseForModel(s)
            assertEquals(once, normaliseForModel(once), "not idempotent for: $s")
        }
    }
}
