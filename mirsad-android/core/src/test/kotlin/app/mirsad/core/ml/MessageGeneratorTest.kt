package app.mirsad.core.ml

import app.mirsad.core.ml.train.MessageGenerator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MessageGeneratorTest {
    private val rows = MessageGenerator(seed = 42).generate(150, 150)

    @Test
    fun `is deterministic for the same seed`() {
        assertEquals(rows, MessageGenerator(seed = 42).generate(150, 150))
    }

    @Test
    fun `produces the requested balanced counts across three languages with unique texts`() {
        assertEquals(150, rows.count { it.isScam })
        assertEquals(150, rows.count { !it.isScam })
        assertEquals(rows.size, rows.map { it.text }.toSet().size)
        for (label in listOf("scam", "legit")) {
            for (lang in listOf("en", "ar", "ar-latn")) {
                assertTrue(rows.any { it.label == label && it.lang == lang }, "missing $label/$lang")
            }
        }
        assertTrue(rows.all { it.channel == "SMS" || it.channel == "CHAT" })
        assertTrue(rows.all { it.synthetic })
        rows.forEach { assertTrue(!it.text.contains('{') && !it.text.contains('}'), "unfilled slot in: ${it.text}") }
        rows.forEach { assertTrue(it.sender.isNotBlank() && it.text.isNotBlank()) }
    }

    @Test
    fun `scam links end in example and legit links use only official hosts`() {
        val host = Regex("""(?i)(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:/\S*)?""")
        for (row in rows) {
            val hosts = host.findAll(row.text).map { it.groupValues[1].lowercase() }.toList()
            if (row.isScam) {
                hosts.forEach { h ->
                    assertTrue(h.endsWith(".example") || h == "t.me" || h == "wa.me", "scam host $h in: ${row.text}")
                }
            } else {
                hosts.forEach { h -> assertTrue(h in MessageGenerator.Entities.OFFICIAL_HOSTS, "legit host $h in: ${row.text}") }
            }
        }
    }

    @Test
    fun `every phone number and iban is zero filled`() {
        val phone = Regex("""\+\d{6,}""")
        val iban = Regex("""AE\d{21}""")
        for (row in rows) {
            for (m in phone.findAll(row.sender + " " + row.text)) {
                assertTrue(m.value.contains("000000"), "number not zero-filled: ${m.value} in ${row.text}")
            }
            for (m in iban.findAll(row.text)) {
                assertTrue(m.value.contains("0".repeat(15)), "iban not zero-filled: ${m.value}")
            }
        }
    }
}
