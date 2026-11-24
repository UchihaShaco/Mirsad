package app.mirsad.core.report

import app.mirsad.core.contract.FalsePositiveReport
import app.mirsad.core.contract.ReportPreview
import app.mirsad.core.contract.ScamReport
import app.mirsad.core.contract.SenderType

/**
 * One language-neutral line of the report preview. [ReportPreviewText] renders it in English or Arabic.
 * [count] and [count2] carry item counts (links, domains...), [value] a masked sender number or an ID.
 */
data class PreviewLine(val key: Key, val count: Int = 0, val count2: Int = 0, val value: String = "") {
    enum class Key {
        // What is in the JSON
        SENDER_NUMBER, SENDER_ID, SENDER_CONTACT_WITHHELD, SENDER_TYPE_ONLY,
        LINKS, IBANS, EMAILS, WALLETS, HANDLES, PHONES,
        VERDICT, USER_VERDICT, FINGERPRINT, CHANNEL_LANGUAGE, VERSIONS, SYNTHETIC, TEXT,

        // What is never in the JSON
        EX_CONTACTS, EX_OTHER_MESSAGES, EX_LOCATION, EX_DEVICE_IDS, EX_OWN_NUMBER, EX_TEXT, EX_SENDER_NAME, EX_SENDER,
    }
}

/** Builds the preview lines from a report. The same lines feed the English and the Arabic rendering. */
object ReportPreviewLines {
    private const val MASK_KEEP = 5

    fun included(report: ScamReport): List<PreviewLine> {
        val a = report.artifacts
        val lines = mutableListOf<PreviewLine>()
        when (a.senderType) {
            SenderType.NUMBER -> a.sender?.let { lines += PreviewLine(PreviewLine.Key.SENDER_NUMBER, value = mask(it)) }
            SenderType.ALPHANUMERIC -> a.sender?.let { lines += PreviewLine(PreviewLine.Key.SENDER_ID, value = it) }
            SenderType.CONTACT -> lines += PreviewLine(PreviewLine.Key.SENDER_CONTACT_WITHHELD)
            SenderType.UNKNOWN -> Unit
        }
        if (a.urls.isNotEmpty() || a.domains.isNotEmpty()) {
            lines += PreviewLine(PreviewLine.Key.LINKS, count = a.urls.size, count2 = a.domains.size)
        }
        if (a.ibans.isNotEmpty()) lines += PreviewLine(PreviewLine.Key.IBANS, count = a.ibans.size)
        if (a.emails.isNotEmpty()) lines += PreviewLine(PreviewLine.Key.EMAILS, count = a.emails.size)
        if (a.wallets.isNotEmpty()) lines += PreviewLine(PreviewLine.Key.WALLETS, count = a.wallets.size)
        if (a.handles.isNotEmpty()) lines += PreviewLine(PreviewLine.Key.HANDLES, count = a.handles.size)
        if (a.phones.isNotEmpty()) lines += PreviewLine(PreviewLine.Key.PHONES, count = a.phones.size)
        lines += PreviewLine(PreviewLine.Key.VERDICT)
        lines += PreviewLine(PreviewLine.Key.FINGERPRINT)
        lines += PreviewLine(PreviewLine.Key.CHANNEL_LANGUAGE)
        lines += PreviewLine(PreviewLine.Key.VERSIONS)
        if (report.synthetic) lines += PreviewLine(PreviewLine.Key.SYNTHETIC)
        if (report.text != null) lines += PreviewLine(PreviewLine.Key.TEXT)
        return lines
    }

    fun excluded(report: ScamReport): List<PreviewLine> {
        val lines = alwaysExcluded()
        if (report.artifacts.senderType == SenderType.CONTACT) lines += PreviewLine(PreviewLine.Key.EX_SENDER_NAME)
        if (report.text == null) lines += PreviewLine(PreviewLine.Key.EX_TEXT)
        return lines
    }

    fun included(report: FalsePositiveReport): List<PreviewLine> {
        val lines = mutableListOf<PreviewLine>()
        lines += PreviewLine(PreviewLine.Key.USER_VERDICT)
        lines += PreviewLine(PreviewLine.Key.SENDER_TYPE_ONLY)
        lines += PreviewLine(PreviewLine.Key.FINGERPRINT)
        lines += PreviewLine(PreviewLine.Key.VERSIONS)
        if (report.synthetic) lines += PreviewLine(PreviewLine.Key.SYNTHETIC)
        if (report.text != null) lines += PreviewLine(PreviewLine.Key.TEXT)
        return lines
    }

    fun excluded(report: FalsePositiveReport): List<PreviewLine> {
        val lines = alwaysExcluded()
        lines += PreviewLine(PreviewLine.Key.EX_SENDER)
        if (report.text == null) lines += PreviewLine(PreviewLine.Key.EX_TEXT)
        return lines
    }

    private fun alwaysExcluded() = mutableListOf(
        PreviewLine(PreviewLine.Key.EX_CONTACTS),
        PreviewLine(PreviewLine.Key.EX_OTHER_MESSAGES),
        PreviewLine(PreviewLine.Key.EX_LOCATION),
        PreviewLine(PreviewLine.Key.EX_DEVICE_IDS),
        PreviewLine(PreviewLine.Key.EX_OWN_NUMBER),
    )

    /** `+440000000001` -> `+4400…`: enough to recognise the number, not enough to dial it from the preview. */
    fun mask(number: String): String =
        if (number.length <= MASK_KEEP) number else number.take(MASK_KEEP) + "…"
}

/** English and Arabic renderings of [PreviewLine]. The UI picks the language; the JSON is the same. */
object ReportPreviewText {
    fun en(lines: List<PreviewLine>): List<String> = lines.map(::en)
    fun ar(lines: List<PreviewLine>): List<String> = lines.map(::ar)

    /** Arabic preview with the same JSON as [DefaultReportBuilder.preview]. */
    fun ar(report: ScamReport): ReportPreview = ReportPreview(
        json = ReportJson.pretty.encodeToString(ScamReport.serializer(), report),
        included = ar(ReportPreviewLines.included(report)),
        excluded = ar(ReportPreviewLines.excluded(report)),
    )

    fun ar(report: FalsePositiveReport): ReportPreview = ReportPreview(
        json = ReportJson.pretty.encodeToString(FalsePositiveReport.serializer(), report),
        included = ar(ReportPreviewLines.included(report)),
        excluded = ar(ReportPreviewLines.excluded(report)),
    )

    fun en(line: PreviewLine): String = when (line.key) {
        PreviewLine.Key.SENDER_NUMBER -> "Sender number ${line.value}"
        PreviewLine.Key.SENDER_ID -> "Sender ID \"${line.value}\""
        PreviewLine.Key.SENDER_CONTACT_WITHHELD -> "That the sender is a saved contact (the name is withheld)"
        PreviewLine.Key.SENDER_TYPE_ONLY -> "Sender type only (number, ID or contact), not the sender itself"
        PreviewLine.Key.LINKS -> when {
            line.count > 0 && line.count2 > 0 -> "${plural(line.count, "link", "links")} and ${if (line.count2 == 1) "its domain" else "their domains"}"
            line.count > 0 -> plural(line.count, "link", "links")
            else -> plural(line.count2, "domain", "domains")
        }
        PreviewLine.Key.IBANS -> plural(line.count, "IBAN", "IBANs")
        PreviewLine.Key.EMAILS -> plural(line.count, "email address", "email addresses")
        PreviewLine.Key.WALLETS -> plural(line.count, "crypto wallet address", "crypto wallet addresses")
        PreviewLine.Key.HANDLES -> plural(line.count, "social or messaging handle", "social or messaging handles")
        PreviewLine.Key.PHONES -> plural(line.count, "phone number mentioned in the message", "phone numbers mentioned in the message")
        PreviewLine.Key.VERDICT -> "Verdict, score and reason codes"
        PreviewLine.Key.USER_VERDICT -> "Your verdict (not a scam) and the reason codes Mirsad used"
        PreviewLine.Key.FINGERPRINT -> "Message fingerprint (a hash, not the text)"
        PreviewLine.Key.CHANNEL_LANGUAGE -> "Channel (call, SMS or chat) and detected language"
        PreviewLine.Key.VERSIONS -> "Mirsad version and model version"
        PreviewLine.Key.SYNTHETIC -> "A flag that this is synthetic demo data"
        PreviewLine.Key.TEXT -> "The message text"
        PreviewLine.Key.EX_CONTACTS -> "Your contacts"
        PreviewLine.Key.EX_OTHER_MESSAGES -> "Other messages"
        PreviewLine.Key.EX_LOCATION -> "Your location"
        PreviewLine.Key.EX_DEVICE_IDS -> "Device identifiers (IMEI, Android ID)"
        PreviewLine.Key.EX_OWN_NUMBER -> "Your own phone number"
        PreviewLine.Key.EX_TEXT -> "The message text"
        PreviewLine.Key.EX_SENDER_NAME -> "The sender's name"
        PreviewLine.Key.EX_SENDER -> "The sender's number or name"
    }

    fun ar(line: PreviewLine): String = when (line.key) {
        PreviewLine.Key.SENDER_NUMBER -> "رقم المرسل ‎${line.value}‎"
        PreviewLine.Key.SENDER_ID -> "معرّف المرسل \"‎${line.value}‎\""
        PreviewLine.Key.SENDER_CONTACT_WITHHELD -> "أن المرسل جهة اتصال محفوظة (الاسم محجوب)"
        PreviewLine.Key.SENDER_TYPE_ONLY -> "نوع المرسل فقط (رقم أو معرّف أو جهة اتصال) دون المرسل نفسه"
        PreviewLine.Key.LINKS -> when {
            line.count > 0 && line.count2 > 0 ->
                if (line.count == 1) "رابط واحد ونطاقه" else "${line.count} روابط ونطاقاتها"
            line.count > 0 -> if (line.count == 1) "رابط واحد" else "${line.count} روابط"
            else -> if (line.count2 == 1) "نطاق واحد" else "${line.count2} نطاقات"
        }
        PreviewLine.Key.IBANS -> if (line.count == 1) "رقم آيبان (IBAN) واحد" else "${line.count} أرقام آيبان (IBAN)"
        PreviewLine.Key.EMAILS -> if (line.count == 1) "عنوان بريد إلكتروني واحد" else "${line.count} عناوين بريد إلكتروني"
        PreviewLine.Key.WALLETS -> if (line.count == 1) "عنوان محفظة عملات رقمية واحد" else "${line.count} عناوين محافظ عملات رقمية"
        PreviewLine.Key.HANDLES -> if (line.count == 1) "معرّف تواصل واحد" else "${line.count} معرّفات تواصل"
        PreviewLine.Key.PHONES -> if (line.count == 1) "رقم هاتف واحد ورد في الرسالة" else "${line.count} أرقام هواتف وردت في الرسالة"
        PreviewLine.Key.VERDICT -> "الحكم والدرجة ورموز الأسباب"
        PreviewLine.Key.USER_VERDICT -> "حكمك (ليست احتيالاً) ورموز الأسباب التي استخدمها مرصاد"
        PreviewLine.Key.FINGERPRINT -> "بصمة الرسالة (تجزئة رقمية وليس النص)"
        PreviewLine.Key.CHANNEL_LANGUAGE -> "القناة (مكالمة أو رسالة نصية أو محادثة) واللغة المكتشفة"
        PreviewLine.Key.VERSIONS -> "إصدار مرصاد وإصدار النموذج"
        PreviewLine.Key.SYNTHETIC -> "علامة تدل على أن هذه بيانات تجريبية مصطنعة"
        PreviewLine.Key.TEXT -> "نص الرسالة"
        PreviewLine.Key.EX_CONTACTS -> "جهات اتصالك"
        PreviewLine.Key.EX_OTHER_MESSAGES -> "رسائلك الأخرى"
        PreviewLine.Key.EX_LOCATION -> "موقعك"
        PreviewLine.Key.EX_DEVICE_IDS -> "معرّفات الجهاز (IMEI وAndroid ID)"
        PreviewLine.Key.EX_OWN_NUMBER -> "رقم هاتفك"
        PreviewLine.Key.EX_TEXT -> "نص الرسالة"
        PreviewLine.Key.EX_SENDER_NAME -> "اسم المرسل"
        PreviewLine.Key.EX_SENDER -> "رقم المرسل أو اسمه"
    }

    private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"
}
