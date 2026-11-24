package app.mirsad.shield.ui

import android.content.Context
import android.content.pm.PackageManager
import android.text.format.DateUtils
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.mirsad.core.contract.ArtifactType
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.shield.R

/** Plain-language string for every stable reason code. Unknown codes fall back to the code itself. */
@StringRes
fun reasonStringRes(code: String): Int? = when (code) {
    ReasonCodes.SENDER_BLOCKLISTED -> R.string.reason_SENDER_BLOCKLISTED
    ReasonCodes.SENDER_ALLOWLISTED -> R.string.reason_SENDER_ALLOWLISTED
    ReasonCodes.SENDER_LOOKS_LIKE_CONTACT -> R.string.reason_SENDER_LOOKS_LIKE_CONTACT
    ReasonCodes.SENDER_PLAIN_NUMBER_CLAIMS_ENTITY -> R.string.reason_SENDER_PLAIN_NUMBER_CLAIMS_ENTITY
    ReasonCodes.SENDER_FOREIGN_CODE_UAE_ENTITY -> R.string.reason_SENDER_FOREIGN_CODE_UAE_ENTITY
    ReasonCodes.SENDER_ONE_RING_PATTERN -> R.string.reason_SENDER_ONE_RING_PATTERN
    ReasonCodes.SENDER_INTERNATIONAL_CALL -> R.string.reason_SENDER_INTERNATIONAL_CALL
    ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE -> R.string.reason_SENDER_SEEN_IN_HELD_MESSAGE
    ReasonCodes.SENDER_OTP_FROM_ALPHANUMERIC -> R.string.reason_SENDER_OTP_FROM_ALPHANUMERIC
    ReasonCodes.LINK_SHORTENER -> R.string.reason_LINK_SHORTENER
    ReasonCodes.LINK_IP_HOST -> R.string.reason_LINK_IP_HOST
    ReasonCodes.LINK_PUNYCODE_OR_MIXED_SCRIPT -> R.string.reason_LINK_PUNYCODE_OR_MIXED_SCRIPT
    ReasonCodes.LINK_PLAIN_HTTP -> R.string.reason_LINK_PLAIN_HTTP
    ReasonCodes.LINK_HIGH_RISK_TLD -> R.string.reason_LINK_HIGH_RISK_TLD
    ReasonCodes.LINK_LOOKALIKE_OFFICIAL -> R.string.reason_LINK_LOOKALIKE_OFFICIAL
    ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL -> R.string.reason_LINK_BRAND_IN_HOST_NOT_OFFICIAL
    ReasonCodes.LINK_BLOCKLISTED_DOMAIN -> R.string.reason_LINK_BLOCKLISTED_DOMAIN
    ReasonCodes.LINK_PRESENT -> R.string.reason_LINK_PRESENT
    ReasonCodes.CONTENT_URGENCY -> R.string.reason_CONTENT_URGENCY
    ReasonCodes.CONTENT_THREAT -> R.string.reason_CONTENT_THREAT
    ReasonCodes.CONTENT_CREDENTIAL_REQUEST -> R.string.reason_CONTENT_CREDENTIAL_REQUEST
    ReasonCodes.CONTENT_SMALL_FEE_LINK -> R.string.reason_CONTENT_SMALL_FEE_LINK
    ReasonCodes.CONTENT_PRIZE -> R.string.reason_CONTENT_PRIZE
    ReasonCodes.CONTENT_JOB_OFFER -> R.string.reason_CONTENT_JOB_OFFER
    ReasonCodes.CONTENT_INVESTMENT -> R.string.reason_CONTENT_INVESTMENT
    ReasonCodes.CONTENT_REMOTE_ACCESS_APP -> R.string.reason_CONTENT_REMOTE_ACCESS_APP
    ReasonCodes.CONTENT_MOVE_TO_MESSENGER -> R.string.reason_CONTENT_MOVE_TO_MESSENGER
    ReasonCodes.CONTENT_PAYMENT_REQUEST -> R.string.reason_CONTENT_PAYMENT_REQUEST
    ReasonCodes.CONTENT_NEW_NUMBER_RELATIVE -> R.string.reason_CONTENT_NEW_NUMBER_RELATIVE
    ReasonCodes.CONTENT_IMPERSONATES_ENTITY -> R.string.reason_CONTENT_IMPERSONATES_ENTITY
    ReasonCodes.CONTENT_OTP_REQUEST -> R.string.reason_CONTENT_OTP_REQUEST
    ReasonCodes.FINGERPRINT_BLOCKLISTED -> R.string.reason_FINGERPRINT_BLOCKLISTED
    ReasonCodes.FINGERPRINT_KNOWN_GOOD -> R.string.reason_FINGERPRINT_KNOWN_GOOD
    ReasonCodes.MODEL_SCORE -> R.string.reason_MODEL_SCORE
    ReasonCodes.CONTENT_HIDDEN -> R.string.reason_CONTENT_HIDDEN
    ReasonCodes.ENGINE_TIMEOUT -> R.string.reason_ENGINE_TIMEOUT
    ReasonCodes.ENGINE_ERROR -> R.string.reason_ENGINE_ERROR
    else -> null
}

@Composable
fun reasonText(reason: Reason): String {
    val res = reasonStringRes(reason.code)
    return if (res != null) stringResource(res) else stringResource(R.string.reason_unknown, reason.code)
}

@Composable
fun levelLabel(level: Level): String = stringResource(
    when (level) {
        Level.ALLOW -> R.string.level_allow
        Level.WARN -> R.string.level_warn
        Level.HOLD -> R.string.level_hold
    },
)

@Composable
fun levelHeadline(level: Level): String = stringResource(
    when (level) {
        Level.ALLOW -> R.string.level_allow_long
        Level.WARN -> R.string.level_warn_long
        Level.HOLD -> R.string.level_hold_long
    },
)

@Composable
fun channelLabel(channel: Channel): String = stringResource(
    when (channel) {
        Channel.CALL -> R.string.channel_call
        Channel.SMS -> R.string.channel_sms
        Channel.CHAT -> R.string.channel_chat
    },
)

fun channelIcon(channel: Channel): Int = when (channel) {
    Channel.CALL -> R.drawable.ic_call
    Channel.SMS -> R.drawable.ic_sms
    Channel.CHAT -> R.drawable.ic_chat
}

@Composable
fun sourceLabel(source: IncidentSource): String = stringResource(
    when (source) {
        IncidentSource.DEMO -> R.string.source_demo
        IncidentSource.SHARE -> R.string.source_share
        IncidentSource.NOTIFICATION -> R.string.source_notification
        IncidentSource.CALL_SCREENING -> R.string.source_call_screening
        IncidentSource.MANUAL -> R.string.source_manual
    },
)

@StringRes
fun artifactTypeRes(type: ArtifactType): Int = when (type) {
    ArtifactType.PHONE -> R.string.artifact_phone
    ArtifactType.URL -> R.string.artifact_url
    ArtifactType.DOMAIN -> R.string.artifact_domain
    ArtifactType.IBAN -> R.string.artifact_iban
    ArtifactType.EMAIL -> R.string.artifact_email
    ArtifactType.WALLET -> R.string.artifact_wallet
    ArtifactType.HANDLE -> R.string.artifact_handle
}

/** "3 min. ago" style relative time, localised by the system. */
fun relativeTime(epochMillis: Long, now: Long = System.currentTimeMillis()): String =
    DateUtils.getRelativeTimeSpanString(epochMillis, now, DateUtils.MINUTE_IN_MILLIS).toString()

/** Human app name for a package: installed label when available, else a known brand name, else the package. */
fun appLabel(context: Context, packageName: String?): String? {
    if (packageName.isNullOrBlank()) return null
    val known = when (packageName) {
        DefaultPackages.GOOGLE_MESSAGES, DefaultPackages.AOSP_MESSAGING, DefaultPackages.SAMSUNG_MESSAGES -> "Messages"
        DefaultPackages.WHATSAPP -> "WhatsApp"
        DefaultPackages.WHATSAPP_BUSINESS -> "WhatsApp Business"
        DefaultPackages.TELEGRAM -> "Telegram"
        DefaultPackages.BOTIM -> "Botim"
        else -> null
    }
    return try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        known ?: packageName
    }
}

/** Day start in local time, for "flagged today". */
fun startOfToday(now: Long = System.currentTimeMillis()): Long {
    val cal = java.util.Calendar.getInstance()
    cal.timeInMillis = now
    cal.set(java.util.Calendar.HOUR_OF_DAY, 0)
    cal.set(java.util.Calendar.MINUTE, 0)
    cal.set(java.util.Calendar.SECOND, 0)
    cal.set(java.util.Calendar.MILLISECOND, 0)
    return cal.timeInMillis
}

/** Wraps [text] in an LTR isolate (U+2066..U+2069) so "+4400…" and "+0.70" keep their sign on the left in RTL. */
fun ltrIsolate(text: String): String = "\u2066" + text + "\u2069"

/** Isolates text that starts with a sign or digit (numbers have no strong direction of their own). */
fun bidiSafe(text: String): String =
    if (text.firstOrNull()?.let { it == '+' || it.isDigit() } == true) ltrIsolate(text) else text

private fun isRtlChar(c: Char): Boolean = when (Character.getDirectionality(c)) {
    Character.DIRECTIONALITY_RIGHT_TO_LEFT, Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC -> true
    else -> false
}

/**
 * Style for user content: paragraph direction and alignment follow the text's first strong letter, so an English
 * message stays left-aligned LTR inside the Arabic UI and an Arabic message stays right-aligned RTL inside the
 * English UI. Compose's TextAlign.Start follows the layout direction, hence the explicit Left/Right.
 */
fun contentStyle(base: androidx.compose.ui.text.TextStyle, text: String?): androidx.compose.ui.text.TextStyle {
    val first = text?.firstOrNull { Character.getDirectionality(it).let { d -> d == Character.DIRECTIONALITY_LEFT_TO_RIGHT || isRtlChar(it) } }
        ?: return base.copy(textDirection = androidx.compose.ui.text.style.TextDirection.Content, textAlign = androidx.compose.ui.text.style.TextAlign.Start)
    return if (isRtlChar(first)) {
        base.copy(textDirection = androidx.compose.ui.text.style.TextDirection.Rtl, textAlign = androidx.compose.ui.text.style.TextAlign.Right)
    } else {
        base.copy(textDirection = androidx.compose.ui.text.style.TextDirection.Ltr, textAlign = androidx.compose.ui.text.style.TextAlign.Left)
    }
}
