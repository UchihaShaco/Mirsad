package app.mirsad.core.engine

import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.contract.ArtifactType
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Classifier
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Language
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.core.contract.Sensitivity
import app.mirsad.core.contract.Verdict
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** End-to-end over the synthetic seed rows (every number zero-filled, every domain .example). */
class MirsadEngineSeedTest {
    data class Row(val label: String, val lang: String, val channel: Channel, val sender: String, val text: String)

    private val seeds = listOf(
        Row("scam", "en", Channel.SMS, "+440000000001", "Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours or it will be returned: http://emiratespost-ae.delivery-fee.example/pay"),
        Row("scam", "ar", Channel.SMS, "+920000000002", "عزيزي العميل، تم تعليق بطاقتك البنكية. لتفعيلها حدّث بياناتك خلال 24 ساعة عبر الرابط: http://bank-update.example/ae"),
        Row("scam", "en", Channel.SMS, "+971500000003", "Dear customer, your Emirates ID is not linked to your bank account. Your card will be blocked today. Update your KYC now: https://uae-kyc-verify.example"),
        Row("scam", "en", Channel.SMS, "ABUDHABI-PL", "Abu Dhabi Police: you have an unpaid traffic fine of AED 150. Pay within 12 hours to avoid a surcharge: http://adpolice-fines.example"),
        Row("scam", "ar", Channel.SMS, "+440000000004", "شرطة دبي: لديك مخالفة مرورية غير مدفوعة بقيمة 300 درهم. ادفع الآن لتجنب مضاعفة الغرامة: http://dubaipolice-pay.example"),
        Row("scam", "en", Channel.CHAT, "+920000000005", "Hello, this is the Central Bank security team. Your account was used in a suspicious transfer. Share the OTP sent to your phone so we can stop it."),
        Row("scam", "ar", Channel.CHAT, "+971500000006", "مبروك! ربحت جائزة 50,000 درهم من سحب اتصالات. أرسل رقم بطاقتك ورمز التحقق لاستلام الجائزة."),
        Row("scam", "en", Channel.CHAT, "+630000000007", "Part-time job from home, AED 800 per day, just like videos. Message our HR on Telegram: t.me/hr_uae_jobs_example"),
        Row("scam", "en", Channel.SMS, "SALIK-INFO", "SALIK: your balance is low and your tag will be suspended. Recharge now: http://salik-recharge.example"),
        Row("scam", "ar", Channel.SMS, "+971500000008", "هيئة كهرباء ومياه دبي: فاتورتك متأخرة وسيتم قطع الخدمة اليوم. سدد فوراً عبر الرابط http://dewa-bill.example"),
        Row("scam", "en", Channel.CHAT, "+440000000009", "Hi Mum, I dropped my phone, this is my new number. Can you send AED 2,000 today? IBAN AE070331234567890123456"),
        Row("scam", "en", Channel.SMS, "+971500000010", "Your UAE Pass login request is pending. If this was not you, cancel it here: http://uaepass-cancel.example"),
        Row("scam", "en", Channel.CHAT, "+100000000011", "Guaranteed 30% monthly profit trading gold and crypto, licensed in Dubai. Join our group: wa.me/0000000000"),
        Row("scam", "en", Channel.CHAT, "+910000000012", "Sir, this is technical support from your bank. Please install AnyDesk so I can fix your blocked card."),
        Row("legit", "en", Channel.SMS, "ADCB", "Your OTP is 482913 for a purchase of AED 120.00 at CARREFOUR. Do not share this code with anyone."),
        Row("legit", "ar", Channel.SMS, "FAB", "رمز التحقق الخاص بك هو 771204. لا تشارك هذا الرمز مع أي شخص."),
        Row("legit", "en", Channel.SMS, "Aramex", "Your shipment 4521 is out for delivery today between 2 PM and 6 PM."),
        Row("legit", "en", Channel.SMS, "DEWA", "Your bill for October is AED 412.35, due on 15 Nov. You can pay in the DEWA app."),
        Row("legit", "en", Channel.SMS, "NOON", "Yellow Friday sale: up to 70% off, today only. Shop in the app."),
        Row("legit", "en", Channel.SMS, "SEHA", "Reminder: your appointment is on 26 Nov at 09:30. Reply 1 to confirm."),
        Row("legit", "en", Channel.CHAT, "Khalid", "Are we still on for padel at 8? I booked court 3."),
        Row("legit", "ar", Channel.CHAT, "Abu Omar", "السلام عليكم، الاجتماع بكرة الساعة 10 الصبح في المكتب."),
    )

    private val engine = MirsadEngineFactory.create()
    private val stageOne = MirsadEngine.create()

    private fun event(row: Row) = Event(
        channel = row.channel,
        sender = row.sender,
        text = row.text,
        appPackage = if (row.channel == Channel.CHAT) "com.whatsapp" else null,
        timestamp = 0L,
        senderLooksLikeContact = row.sender == "Khalid" || row.sender == "Abu Omar",
    )

    private fun describe(row: Row, v: Verdict) = "%s score=%.2f [%s] %s | %s".format(
        v.level, v.score, row.sender, row.text.take(60),
        v.reasons.joinToString(", ") { it.code + (if (it.hard) "!" else "") + "(%.2f)".format(it.weight) + (it.detail?.let { d -> " $d" } ?: "") },
    )

    @Test
    fun `every scam row is at least warn and all reach hold at balanced`() {
        val failures = ArrayList<String>()
        for (row in seeds.filter { it.label == "scam" }) {
            val v = engine.analyse(event(row))
            println(describe(row, v))
            if (v.level == Level.ALLOW) failures += "not flagged: " + describe(row, v)
            // every seed scam carries a link, credential, payment or remote-access signal
            if (v.level != Level.HOLD) failures += "not held: " + describe(row, v)
            assertTrue(v.hardReasons.isNotEmpty() || v.level != Level.HOLD)
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    @Test
    fun `scam rows hold on stage one alone`() {
        val failures = seeds.filter { it.label == "scam" }
            .map { it to stageOne.analyse(event(it), EngineContext(stageOneOnly = true)) }
            .filter { (_, v) -> v.level != Level.HOLD }
            .map { (row, v) -> describe(row, v) }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    @Test
    fun `legit rows stay allow with at most one warn and never hold`() {
        var warns = 0
        val flagged = ArrayList<String>()
        for (row in seeds.filter { it.label == "legit" }) {
            val v = engine.analyse(event(row))
            println(describe(row, v))
            assertNotEquals(Level.HOLD, v.level, describe(row, v))
            if (v.level == Level.WARN) { warns++; flagged += describe(row, v) }
        }
        assertTrue(warns <= 1, "legit rows warned:\n" + flagged.joinToString("\n"))
    }

    @Test
    fun `legit otp from alphanumeric sender is a safe signal and never a credential request`() {
        val v = engine.analyse(event(seeds[14]))
        assertEquals(Level.ALLOW, v.level)
        assertTrue(v.reasons.any { it.code == ReasonCodes.SENDER_OTP_FROM_ALPHANUMERIC && it.weight < 0 })
        assertFalse(v.reasons.any { it.code == ReasonCodes.CONTENT_CREDENTIAL_REQUEST })
        val ar = engine.analyse(event(seeds[15]))
        assertEquals(Level.ALLOW, ar.level)
        assertEquals(Language.AR, ar.language)
        assertFalse(ar.reasons.any { it.code == ReasonCodes.CONTENT_CREDENTIAL_REQUEST })
        // "Share the OTP" from a plain number is a request
        val scam = engine.analyse(event(seeds[5]))
        assertTrue(scam.reasons.any { it.code == ReasonCodes.CONTENT_CREDENTIAL_REQUEST && it.hard })
        assertTrue(scam.reasons.any { it.code == ReasonCodes.CONTENT_OTP_REQUEST })
        // An OTP-looking text that asks to share the code is capped at WARN, never held
        val delivery = engine.analyse(Event(Channel.SMS, "SHOPX", "Your delivery OTP is 1234. Share it with the agent.", null, 0L, false))
        assertTrue(delivery.level != Level.HOLD)
    }

    @Test
    fun `expected reason codes and artifacts on key rows`() {
        val post = engine.analyse(event(seeds[0]))
        val postCodes = post.reasons.map { it.code }.toSet()
        assertTrue(ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL in postCodes, postCodes.toString())
        assertTrue(ReasonCodes.CONTENT_SMALL_FEE_LINK in postCodes)
        assertTrue(ReasonCodes.SENDER_FOREIGN_CODE_UAE_ENTITY in postCodes)
        assertTrue(ReasonCodes.SENDER_PLAIN_NUMBER_CLAIMS_ENTITY in postCodes)
        assertTrue(ReasonCodes.CONTENT_IMPERSONATES_ENTITY in postCodes)
        assertTrue(ReasonCodes.LINK_PLAIN_HTTP in postCodes)
        assertTrue(ReasonCodes.CONTENT_URGENCY in postCodes)
        assertTrue(post.artifacts.contains(app.mirsad.core.contract.Artifact(ArtifactType.DOMAIN, "delivery-fee.example")))
        assertEquals(Language.EN, post.language)
        assertEquals("1.0.0", post.rulesVersion)

        val mum = engine.analyse(event(seeds[10]))
        val mumCodes = mum.reasons.map { it.code }.toSet()
        assertTrue(ReasonCodes.CONTENT_NEW_NUMBER_RELATIVE in mumCodes, mumCodes.toString())
        assertTrue(mum.reasons.any { it.code == ReasonCodes.CONTENT_PAYMENT_REQUEST && it.hard })
        assertTrue(mum.artifacts.contains(app.mirsad.core.contract.Artifact(ArtifactType.IBAN, "AE070331234567890123456")))

        val job = engine.analyse(event(seeds[7]))
        assertTrue(job.reasons.any { it.code == ReasonCodes.CONTENT_JOB_OFFER && it.hard })
        assertTrue(job.reasons.any { it.code == ReasonCodes.CONTENT_MOVE_TO_MESSENGER })
        assertTrue(job.artifacts.contains(app.mirsad.core.contract.Artifact(ArtifactType.HANDLE, "t.me/hr_uae_jobs_example")))

        val anydesk = engine.analyse(event(seeds[13]))
        assertTrue(anydesk.reasons.any { it.code == ReasonCodes.CONTENT_REMOTE_ACCESS_APP && it.hard })

        val prize = engine.analyse(event(seeds[6]))
        val prizeCodes = prize.reasons.map { it.code }.toSet()
        assertTrue(ReasonCodes.CONTENT_PRIZE in prizeCodes, prizeCodes.toString())
        assertTrue(ReasonCodes.CONTENT_CREDENTIAL_REQUEST in prizeCodes)
        assertEquals(Language.AR, prize.language)
    }

    @Test
    fun `gate caps contacts allowlist hidden content known-good and calls`() {
        val scam = seeds[5]
        val contact = engine.analyse(event(scam).copy(senderLooksLikeContact = true))
        assertEquals(Level.WARN, contact.level)
        assertTrue(contact.reasons.any { it.code == ReasonCodes.SENDER_LOOKS_LIKE_CONTACT })

        val allowed = engine.analyse(event(scam), EngineContext(allowedSenders = setOf("+920000000005")))
        assertEquals(Level.ALLOW, allowed.level)
        assertEquals(listOf(ReasonCodes.SENDER_ALLOWLISTED), allowed.reasons.map { it.code })
        val allowedByName = engine.analyse(event(seeds[0]).copy(sender = "Emirates Post"), EngineContext(allowedSenders = setOf("emirates post")))
        assertEquals(Level.ALLOW, allowedByName.level)

        val hidden = engine.analyse(event(scam).copy(contentHidden = true))
        assertEquals(Level.ALLOW, hidden.level)
        assertEquals(listOf(ReasonCodes.CONTENT_HIDDEN), hidden.reasons.map { it.code })
        assertEquals(SimHash.ZERO, hidden.fingerprint)

        val base = engine.analyse(event(scam))
        val knownGood = engine.analyse(event(scam), EngineContext(knownGoodFingerprints = setOf(base.fingerprint)))
        assertEquals(Level.ALLOW, knownGood.level)
        assertTrue(knownGood.reasons.any { it.code == ReasonCodes.FINGERPRINT_KNOWN_GOOD })
        val knownGoodButBlocked = engine.analyse(
            event(scam),
            EngineContext(knownGoodFingerprints = setOf(base.fingerprint), blockedSenders = setOf("+920000000005")),
        )
        assertEquals(Level.WARN, knownGoodButBlocked.level)

        val blockedFp = engine.analyse(event(seeds[16]), EngineContext(blockedFingerprints = setOf(engine.analyse(event(seeds[16])).fingerprint)))
        assertTrue(blockedFp.reasons.any { it.code == ReasonCodes.FINGERPRINT_BLOCKLISTED && it.hard })
        assertEquals(Level.HOLD, blockedFp.level)

        val blockedSender = engine.analyse(event(seeds[16]), EngineContext(blockedSenders = setOf("aramex")))
        assertEquals(Level.HOLD, blockedSender.level)
    }

    @Test
    fun `calls hold only on blocklist or held number and international is warn at most`() {
        val call = { sender: String, ctx: EngineContext -> engine.analyse(Event(Channel.CALL, sender, null, null, 0L, false), ctx.copy(stageOneOnly = true)) }
        val local = call("+971500000099", EngineContext())
        assertEquals(Level.ALLOW, local.level)
        assertEquals(SimHash.ZERO, local.fingerprint)
        assertEquals(Language.UNKNOWN, local.language)
        assertEquals("none", local.modelVersion)

        val intl = call("+440000000001", EngineContext())
        assertTrue(intl.level != Level.HOLD)
        assertTrue(intl.reasons.any { it.code == ReasonCodes.SENDER_INTERNATIONAL_CALL })

        val oneRing = call("+2320000000", EngineContext())
        assertEquals(Level.WARN, oneRing.level, oneRing.reasons.toString())
        assertTrue(oneRing.reasons.any { it.code == ReasonCodes.SENDER_ONE_RING_PATTERN })
        val oneRingStrictOrRelaxed = call("+2320000000", EngineContext(sensitivity = Sensitivity.STRICT))
        assertTrue(oneRingStrictOrRelaxed.level != Level.HOLD)

        val held = call("+440000000001", EngineContext(recentlyHeldNumbers = setOf("+440000000001")))
        assertEquals(Level.HOLD, held.level)
        assertTrue(held.reasons.any { it.code == ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE && it.hard })

        val blocked = call("00440000000001", EngineContext(blockedSenders = setOf("+440000000001")))
        assertEquals(Level.HOLD, blocked.level)
    }

    @Test
    fun `sensitivity thresholds move the gate`() {
        val borderline = Event(Channel.SMS, "+971500000050", "Your bank card will be blocked today. Verify your details now: http://verify-card.example", null, 0L, false)
        val relaxed = engine.analyse(borderline, EngineContext(sensitivity = Sensitivity.RELAXED))
        val balanced = engine.analyse(borderline, EngineContext(sensitivity = Sensitivity.BALANCED))
        val strict = engine.analyse(borderline, EngineContext(sensitivity = Sensitivity.STRICT))
        assertEquals(relaxed.score, balanced.score)
        assertTrue(relaxed.level <= balanced.level && balanced.level <= strict.level)
        assertEquals(Level.HOLD, strict.level, strict.reasons.toString())
    }

    @Test
    fun `never throws and sets latency`() {
        val throwing = object : Classifier {
            override val modelVersion = "boom"
            override fun scoreScam(normalisedText: String): Double = throw IllegalStateException("boom")
        }
        val e = MirsadEngine.create(throwing)
        val v = e.analyse(Event(Channel.CHAT, "", null, null, 0L, false))
        assertEquals(Level.ALLOW, v.level)
        assertTrue(v.latencyMs >= 0)
        val v2 = e.analyse(event(seeds[0]))
        assertEquals(Level.HOLD, v2.level, "a failing classifier must not disable stage 1")
        val weird = e.analyse(Event(Channel.SMS, "   ", "‮﻿ـ ١٢٣ http://[::1]/x ((( ... @@@ xn-- .. ", null, Long.MIN_VALUE, true))
        assertTrue(weird.score in 0.0..1.0)
        assertEquals(16, weird.fingerprint.length)
    }

    @Test
    fun `thread safe and deterministic`() {
        val expected = seeds.map { engine.analyse(event(it)).copy(latencyMs = 0) }
        val pool = Executors.newFixedThreadPool(8)
        val failures = java.util.concurrent.atomic.AtomicInteger()
        repeat(8) {
            pool.submit {
                repeat(20) {
                    seeds.forEachIndexed { i, row ->
                        if (engine.analyse(event(row)).copy(latencyMs = 0) != expected[i]) failures.incrementAndGet()
                    }
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(60, TimeUnit.SECONDS))
        assertEquals(0, failures.get())
    }

    @Test
    fun `median latency under 100 ms on the jvm after warm-up`() {
        repeat(5) { seeds.forEach { engine.analyse(event(it)) } }
        val samples = ArrayList<Long>()
        repeat(20) {
            seeds.forEach { row ->
                val t0 = System.nanoTime()
                engine.analyse(event(row))
                samples += (System.nanoTime() - t0) / 1_000
            }
        }
        samples.sort()
        val p50us = samples[samples.size / 2]
        val p95us = samples[(samples.size * 95) / 100]
        println("engine latency: p50=${p50us}us p95=${p95us}us max=${samples.last()}us over ${samples.size} analyses")
        assertTrue(p50us < 100_000, "p50 ${p50us}us")
    }
}
