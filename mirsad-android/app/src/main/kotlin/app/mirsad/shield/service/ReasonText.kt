package app.mirsad.shield.service

import android.content.Context
import app.mirsad.core.contract.Reason
import app.mirsad.core.contract.ReasonCodes
import app.mirsad.shield.R

/** Reason codes in plain words for the notices (EN/AR, see strings_notices.xml in values and values-ar). */
object ReasonText {
    private val labels: Map<String, Int> = mapOf(
        ReasonCodes.SENDER_BLOCKLISTED to R.string.reason_sender_blocklisted,
        ReasonCodes.SENDER_KNOWN_SCAMMER_CONTACT to R.string.reason_sender_known_scammer_contact,
        ReasonCodes.SENDER_ALLOWLISTED to R.string.reason_sender_allowlisted,
        ReasonCodes.SENDER_LOOKS_LIKE_CONTACT to R.string.reason_sender_looks_like_contact,
        ReasonCodes.SENDER_PLAIN_NUMBER_CLAIMS_ENTITY to R.string.reason_sender_plain_number_claims_entity,
        ReasonCodes.SENDER_FOREIGN_CODE_UAE_ENTITY to R.string.reason_sender_foreign_code_uae_entity,
        ReasonCodes.SENDER_ONE_RING_PATTERN to R.string.reason_sender_one_ring_pattern,
        ReasonCodes.SENDER_INTERNATIONAL_CALL to R.string.reason_sender_international_call,
        ReasonCodes.SENDER_SEEN_IN_HELD_MESSAGE to R.string.reason_sender_seen_in_held_message,
        ReasonCodes.SENDER_OTP_FROM_ALPHANUMERIC to R.string.reason_sender_otp_from_alphanumeric,
        ReasonCodes.LINK_SHORTENER to R.string.reason_link_shortener,
        ReasonCodes.LINK_IP_HOST to R.string.reason_link_ip_host,
        ReasonCodes.LINK_PUNYCODE_OR_MIXED_SCRIPT to R.string.reason_link_punycode_or_mixed_script,
        ReasonCodes.LINK_PLAIN_HTTP to R.string.reason_link_plain_http,
        ReasonCodes.LINK_HIGH_RISK_TLD to R.string.reason_link_high_risk_tld,
        ReasonCodes.LINK_LOOKALIKE_OFFICIAL to R.string.reason_link_lookalike_official,
        ReasonCodes.LINK_BRAND_IN_HOST_NOT_OFFICIAL to R.string.reason_link_brand_in_host_not_official,
        ReasonCodes.LINK_BLOCKLISTED_DOMAIN to R.string.reason_link_blocklisted_domain,
        ReasonCodes.LINK_PRESENT to R.string.reason_link_present,
        ReasonCodes.CONTENT_URGENCY to R.string.reason_content_urgency,
        ReasonCodes.CONTENT_THREAT to R.string.reason_content_threat,
        ReasonCodes.CONTENT_CREDENTIAL_REQUEST to R.string.reason_content_credential_request,
        ReasonCodes.CONTENT_SMALL_FEE_LINK to R.string.reason_content_small_fee_link,
        ReasonCodes.CONTENT_PRIZE to R.string.reason_content_prize,
        ReasonCodes.CONTENT_JOB_OFFER to R.string.reason_content_job_offer,
        ReasonCodes.CONTENT_INVESTMENT to R.string.reason_content_investment,
        ReasonCodes.CONTENT_REMOTE_ACCESS_APP to R.string.reason_content_remote_access_app,
        ReasonCodes.CONTENT_MOVE_TO_MESSENGER to R.string.reason_content_move_to_messenger,
        ReasonCodes.CONTENT_PAYMENT_REQUEST to R.string.reason_content_payment_request,
        ReasonCodes.CONTENT_NEW_NUMBER_RELATIVE to R.string.reason_content_new_number_relative,
        ReasonCodes.CONTENT_IMPERSONATES_ENTITY to R.string.reason_content_impersonates_entity,
        ReasonCodes.CONTENT_OTP_REQUEST to R.string.reason_content_otp_request,
        ReasonCodes.FINGERPRINT_BLOCKLISTED to R.string.reason_fingerprint_blocklisted,
        ReasonCodes.FINGERPRINT_KNOWN_GOOD to R.string.reason_fingerprint_known_good,
        ReasonCodes.MODEL_SCORE to R.string.reason_model_score,
        ReasonCodes.CONTENT_HIDDEN to R.string.reason_content_hidden,
        ReasonCodes.ENGINE_TIMEOUT to R.string.reason_engine_timeout,
        ReasonCodes.ENGINE_ERROR to R.string.reason_engine_error,
    )

    fun describe(context: Context, reason: Reason): String {
        val base = context.getString(labels[reason.code] ?: R.string.reason_generic)
        val detail = app.mirsad.core.contract.ReasonDetail.display(reason)?.takeIf { reason.code.startsWith("LINK_") }
        return if (detail != null) "$base ($detail)" else base
    }

    /** Up to [max] distinct reasons that count against the message: hard evidence first, then by weight. */
    fun summary(context: Context, reasons: List<Reason>, max: Int = 3): List<String> =
        app.mirsad.core.contract.ReasonOrder.top(reasons, reasons.size)
            .map { describe(context, it) }
            .distinct()
            .take(max)
}
