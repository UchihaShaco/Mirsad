package app.mirsad.core.report

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class BlocklistParserTest {

    @Test
    fun `parses the example file shipped in the app assets`() {
        val url = assertNotNull(javaClass.classLoader.getResource("blocklist_example.json"), "app assets are core resources")
        val parsed = BlocklistParser.parse(url.readText())
        assertEquals(1, parsed.version)
        assertEquals(listOf("+440000000001", "+920000000002"), parsed.numbers)
        assertEquals(listOf("delivery-fee.example", "bank-update.example"), parsed.domains)
        assertTrue(parsed.fingerprints.isEmpty())
        assertTrue(parsed.issuer.orEmpty().contains("synthetic"))
        val normalised = BlocklistParser.normalise(parsed)
        assertEquals(0, normalised.dropped)
        assertEquals(parsed, normalised.file)
    }

    @Test
    fun `is lenient and normalises every list, dropping what it cannot read`() {
        val text = """
            {
              "version": 1,
              "issuer": "test",
              "unknownKey": {"nested": true},
              "numbers": ["0501234567", "00 44 0000 000001", "+971 50 000 0003", "ADCB", "2828", "+971500000003"],
              "domains": ["HTTPS://Pay.Delivery-Fee.EXAMPLE/x?y=1", "bank-update.co.ae", "sub.bank-update.co.ae", "192.168.0.1", "not a domain"],
              "fingerprints": ["0123456789ABCDEF", "0x0123456789abcdef", "zzz"]
            }
        """.trimIndent()
        val result = BlocklistParser.parseAndNormalise(text)
        assertEquals(listOf("+971501234567", "+440000000001", "+971500000003"), result.file.numbers)
        assertEquals(listOf("delivery-fee.example", "bank-update.co.ae"), result.file.domains)
        assertEquals(listOf("0123456789abcdef"), result.file.fingerprints)
        assertEquals(5, result.dropped)
        assertEquals(listOf("ADCB", "2828", "192.168.0.1", "not a domain", "zzz"), result.droppedValues)
        assertEquals("test", result.file.issuer)
    }

    @Test
    fun `missing or null lists are empty`() {
        val a = BlocklistParser.parse("""{"version": 1}""")
        assertTrue(a.numbers.isEmpty() && a.domains.isEmpty() && a.fingerprints.isEmpty())
        val b = BlocklistParser.parse("""{"numbers": null, "domains": ["x.example"]}""")
        assertTrue(b.numbers.isEmpty())
        assertEquals(listOf("x.example"), b.domains)
        assertEquals(1, b.version)
    }

    @Test
    fun `rejects text that is not a blocklist file`() {
        assertFailsWith<IllegalArgumentException> { BlocklistParser.parse("") }
        assertFailsWith<IllegalArgumentException> { BlocklistParser.parse("   ") }
        assertFailsWith<IllegalArgumentException> { BlocklistParser.parse("not json at all {") }
        assertFailsWith<IllegalArgumentException> { BlocklistParser.parse("""{"numbers": "+440000000001"}""") }
        assertFailsWith<IllegalArgumentException> { BlocklistParser.parse("[1, 2, 3]") }
    }
}
