package app.mirsad.shield.demo

import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.Event

/**
 * Synthetic demo messages. Every number is zero-filled and fictional, every domain ends in .example.
 * The Demo screen and the debug autopilot run these through the real pipeline with synthetic = true.
 */
data class DemoSample(
    val sender: String,
    val text: String,
    val channel: Channel,
    val scam: Boolean,
    /** True when the sender is a display name treated as a saved contact. */
    val contact: Boolean = false,
) {
    fun toEvent(now: Long = System.currentTimeMillis()): Event = Event(
        channel = channel,
        sender = sender,
        text = text,
        appPackage = when (channel) {
            Channel.CALL -> null
            Channel.SMS -> DefaultPackages.GOOGLE_MESSAGES
            Channel.CHAT -> DefaultPackages.WHATSAPP
        },
        timestamp = now,
        senderLooksLikeContact = contact,
    )
}

object DemoSeeds {
    /** The storyboard scam: a parcel-fee message with a look-alike link. */
    val PARCEL_FEE = DemoSample(
        "+440000000001",
        "Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours or it will be returned: " +
            "http://emiratespost-ae.delivery-fee.example/pay",
        Channel.SMS, scam = true,
    )

    /** A legitimate bank code: must always be ALLOW. */
    val ADCB_OTP = DemoSample(
        "ADCB",
        "Your OTP is 482913 for a purchase of AED 120.00 at CARREFOUR. Do not share this code with anyone.",
        Channel.SMS, scam = false,
    )

    /**
     * A legitimate message that Mirsad wrongly HOLDS: a friend who really changed number and asks to be paid
     * back, with an IBAN. To the engine it is indistinguishable from the "relative with a new number" scam,
     * so it is the honest example for the one-tap "Not a scam" flow. The IBAN is fictional (valid check digits).
     */
    val FRIEND_NEW_NUMBER = DemoSample(
        "+971500000041",
        "Hi, it is Omar, this is my new number. Can you transfer the AED 500 for the football pitch today? " +
            "My IBAN is AE440330000000000000042",
        Channel.CHAT, scam = false,
    )

    /** Legitimate messages the engine gets wrong; shown in their own Demo section. */
    val wronglyHeld: List<DemoSample> = listOf(FRIEND_NEW_NUMBER)

    const val DEMO_CALL_NUMBER = "+440000000001"

    val scams: List<DemoSample> = listOf(
        PARCEL_FEE,
        DemoSample(
            "+920000000002",
            "عزيزي العميل، تم تعليق بطاقتك البنكية. لتفعيلها حدّث بياناتك خلال 24 ساعة عبر الرابط: http://bank-update.example/ae",
            Channel.SMS, scam = true,
        ),
        DemoSample(
            "ABUDHABI-PL",
            "Abu Dhabi Police: you have an unpaid traffic fine of AED 150. Pay within 12 hours to avoid a surcharge: http://adpolice-fines.example",
            Channel.SMS, scam = true,
        ),
        DemoSample(
            "+920000000005",
            "Hello, this is the Central Bank security team. Your account was used in a suspicious transfer. Share the OTP sent to your phone so we can stop it.",
            Channel.CHAT, scam = true,
        ),
        DemoSample(
            "+971500000006",
            "مبروك! ربحت جائزة 50,000 درهم من سحب اتصالات. أرسل رقم بطاقتك ورمز التحقق لاستلام الجائزة.",
            Channel.CHAT, scam = true,
        ),
        DemoSample(
            "+910000000012",
            "Sir, this is technical support from your bank. Please install AnyDesk so I can fix your blocked card.",
            Channel.CHAT, scam = true,
        ),
        DemoSample(
            "+440000000009",
            "Hi Mum, I dropped my phone, this is my new number. Can you send AED 2,000 today? IBAN AE070331234567890123456",
            Channel.CHAT, scam = true,
        ),
    )

    val legit: List<DemoSample> = listOf(
        ADCB_OTP,
        DemoSample("FAB", "رمز التحقق الخاص بك هو 771204. لا تشارك هذا الرمز مع أي شخص.", Channel.SMS, scam = false),
        DemoSample("Aramex", "Your shipment 4521 is out for delivery today between 2 PM and 6 PM.", Channel.SMS, scam = false),
        DemoSample("DEWA", "Your bill for October is AED 412.35, due on 15 Nov. You can pay in the DEWA app.", Channel.SMS, scam = false),
        DemoSample("Khalid", "Are we still on for padel at 8? I booked court 3.", Channel.CHAT, scam = false, contact = true),
        DemoSample("Abu Omar", "السلام عليكم، الاجتماع بكرة الساعة 10 الصبح في المكتب.", Channel.CHAT, scam = false, contact = true),
    )

    fun callEvent(number: String, now: Long = System.currentTimeMillis()): Event =
        Event(Channel.CALL, number, null, null, now, false)
}
