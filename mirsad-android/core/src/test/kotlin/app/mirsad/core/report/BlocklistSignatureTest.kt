package app.mirsad.core.report

import app.mirsad.core.report.BlocklistSignature.Check
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** The portal-signed fixture in contracts/fixtures (shared with the portal's own test) verifies here, byte for byte. */
class BlocklistSignatureTest {
    private fun fixture(name: String): String {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "contracts/fixtures/$name") }.firstOrNull { it.isFile }
        return requireNotNull(file) { "contracts/fixtures/$name not found above ${File("").absolutePath}" }.readText()
    }

    private val signed = BlocklistParser.parse(fixture("blocklist.v1.signed.json"))
    private val key = Json.parseToJsonElement(fixture("blocklist-test-key.json")).jsonObject.let {
        BlocklistSignature.TrustedKey(it["keyId"]!!.jsonPrimitive.content, it["issuer"]!!.jsonPrimitive.content, it["publicKey"]!!.jsonPrimitive.content)
    }
    private val now = Instant.parse("2026-11-25T12:00:00Z").toEpochMilli()

    @Test
    fun `a list signed by the portal verifies with its key`() {
        val check = BlocklistSignature.check(signed, listOf(key), now)
        assertIs<Check.Verified>(check)
        assertEquals(key.keyId, check.key.keyId)
        assertEquals(listOf("+971500000401", "+971500000403"), signed.numbers)
    }

    @Test
    fun `the signed text matches the portal's layout`() {
        assertEquals(
            listOf("mirsad-blocklist-v1", "keyId:${key.keyId}", "issuer:${signed.issuer}", "issuedAt:2026-11-25T00:00:00.000Z",
                "expiresAt:2099-12-31T00:00:00.000Z", "numbers:+971500000401,+971500000403", "domains:", "fingerprints:1111111111111111"),
            BlocklistSignature.signedText(signed).split("\n"),
        )
    }

    @Test
    fun `a changed list, an unknown key and an expired list are refused`() {
        assertIs<Check.Rejected>(BlocklistSignature.check(signed.copy(numbers = listOf("+971500000401")), listOf(key), now))
        assertIs<Check.Rejected>(BlocklistSignature.check(signed.copy(issuer = "Someone else"), listOf(key), now))
        assertIs<Check.Rejected>(BlocklistSignature.check(signed, emptyList(), now))
        val later = Instant.parse("2100-01-01T00:00:00Z").toEpochMilli()
        val expired = BlocklistSignature.check(signed, listOf(key), later)
        assertIs<Check.Rejected>(expired)
        assertTrue(expired.reason.startsWith("This list expired on 2099-12-31"))
        // A wrong key id in the app's own key list is caught before the signature is even checked.
        assertIs<Check.Rejected>(BlocklistSignature.check(signed, listOf(key.copy(publicKey = key.publicKey.reversed())), now))
    }

    @Test
    fun `a list without a signature is a personal list`() {
        assertEquals(Check.Unsigned, BlocklistSignature.check(signed.copy(signature = null), listOf(key), now))
        assertEquals(Check.Unsigned, BlocklistSignature.check(BlocklistParser.parse("""{"numbers":["+440000000001"]}"""), listOf(key), now))
    }
}
