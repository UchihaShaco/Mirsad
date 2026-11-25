package app.mirsad.core.report

import app.mirsad.core.contract.BlocklistFile
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64

/**
 * Checks a blocklist the Mirsad portal signed (repository root, GET /v1/watchlist/blocklist; contracts/README.md).
 *
 * The signature is ECDSA P-256 with SHA-256 (DER, base64) over [signedText], a fixed line-based text built from the
 * file's own field values, so both sides sign and verify the same bytes without canonical JSON. Every Android version
 * the app supports verifies it with the platform's own crypto, and so does the JVM the core tests run on.
 *
 * A list carrying a signature must verify against a key the app trusts, and must not have expired; otherwise it is
 * refused rather than imported as an ordinary list. A list without a signature is a personal list.
 */
object BlocklistSignature {
    /** A key the app ships in assets/trusted_blocklist_keys.json. [publicKey] is SubjectPublicKeyInfo DER, base64. */
    data class TrustedKey(val keyId: String, val issuer: String, val publicKey: String)

    sealed interface Check {
        /** No signature: a personal list, imported as before. */
        data object Unsigned : Check
        /** Signed by [key], untampered and in date: a police list that replaces the previous one from this key. */
        data class Verified(val key: TrustedKey) : Check
        /** Signed, but not by a trusted key, tampered with, or expired. [reason] is shown to the user. */
        data class Rejected(val reason: String) : Check
    }

    fun signedText(file: BlocklistFile): String = listOf(
        "mirsad-blocklist-v1",
        "keyId:${file.keyId.orEmpty()}",
        "issuer:${file.issuer.orEmpty()}",
        "issuedAt:${file.issuedAt.orEmpty()}",
        "expiresAt:${file.expiresAt.orEmpty()}",
        "numbers:${file.numbers.joinToString(",")}",
        "domains:${file.domains.joinToString(",")}",
        "fingerprints:${file.fingerprints.joinToString(",")}",
    ).joinToString("\n")

    /** First 16 hex characters of SHA-256 over the key's DER bytes, as the portal computes it. */
    fun keyIdOf(publicKeyDer: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(publicKeyDer).joinToString("") { "%02x".format(it) }.take(16)

    /** Call with the file as parsed, before normalisation: the signature covers the values as written. */
    fun check(file: BlocklistFile, trusted: List<TrustedKey>, nowMillis: Long): Check {
        val signature = file.signature ?: return Check.Unsigned
        val key = trusted.firstOrNull { it.keyId == file.keyId }
            ?: return Check.Rejected("This list is signed by a key this app does not trust")
        val valid = runCatching {
            val der = Base64.getDecoder().decode(key.publicKey)
            if (keyIdOf(der) != key.keyId) return Check.Rejected("The trusted key in this app is damaged")
            val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(publicKey)
                update(signedText(file).toByteArray(Charsets.UTF_8))
                verify(Base64.getDecoder().decode(signature))
            }
        }.getOrDefault(false)
        if (!valid) return Check.Rejected("The list's signature does not match: it was changed after it was signed")
        val expires = file.expiresAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
            ?: return Check.Rejected("The signed list has no valid expiry date")
        if (expires <= nowMillis) return Check.Rejected("This list expired on ${file.expiresAt!!.take(10)}. Ask for a new one")
        return Check.Verified(key)
    }
}
