package app.mirsad.core.ml

import app.mirsad.core.ml.train.Csv
import app.mirsad.core.ml.train.LabelledMessage
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

class CsvTest {
    @Test
    fun `round trips commas, quotes, newlines and arabic`() {
        val rows = listOf(
            listOf("label", "text"),
            listOf("scam", "Pay AED 3.50, now: \"urgent\""),
            listOf("legit", "line one\nline two"),
            listOf("legit", "السلام عليكم، كيف الحال؟"),
            listOf("", "trailing empty"),
        )
        val text = Csv.format(rows)
        assertEquals(rows, Csv.parse(text))
    }

    @Test
    fun `parses lf and crlf endings and a bom`() {
        assertEquals(listOf(listOf("a", "b"), listOf("1", "2")), Csv.parse("﻿a,b\r\n1,2\n"))
        assertEquals(listOf(listOf("a", "b"), listOf("1", "2")), Csv.parse("a,b\n1,2"))
    }

    @Test
    fun `labelled messages read the seed file and ignore extra columns`() {
        val seeds = TestData.seeds
        assertEquals(22, seeds.size)
        assertEquals(14, seeds.count { it.isScam })
        assertEquals(8, seeds.count { !it.isScam })
        seeds.forEach { assert(it.synthetic) }

        val tmp = File.createTempFile("mirsad", ".csv")
        try {
            tmp.writeText("label,lang,channel,sender,text,synthetic,source\nlegit,en,SMS,ADCB,\"Hi, there\",false,feedback\n")
            val rows = LabelledMessage.readCsv(tmp)
            assertEquals(1, rows.size)
            assertEquals("Hi, there", rows[0].text)
            assertEquals(false, rows[0].synthetic)
        } finally {
            tmp.delete()
        }
    }
}
