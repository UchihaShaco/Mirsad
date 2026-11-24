package app.mirsad.core.ml.train

import java.io.File

/** Minimal RFC 4180 reader/writer. Fields with commas, quotes or line breaks are quoted; quotes are doubled. */
object Csv {
    fun parse(text: String): List<List<String>> {
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val field = StringBuilder()
        var inQuotes = false
        var i = 0
        val s = if (text.startsWith("﻿")) text.substring(1) else text
        val n = s.length
        while (i < n) {
            val c = s[i]
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < n && s[i + 1] == '"') {
                        field.append('"')
                        i++
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(c)
                }
            } else {
                when (c) {
                    '"' -> inQuotes = true
                    ',' -> {
                        row.add(field.toString())
                        field.setLength(0)
                    }
                    '\r' -> Unit
                    '\n' -> {
                        row.add(field.toString())
                        field.setLength(0)
                        rows.add(row)
                        row = ArrayList()
                    }
                    else -> field.append(c)
                }
            }
            i++
        }
        if (field.isNotEmpty() || row.isNotEmpty()) {
            row.add(field.toString())
            rows.add(row)
        }
        return rows
    }

    fun format(rows: List<List<String>>): String {
        val sb = StringBuilder()
        for (row in rows) {
            row.forEachIndexed { idx, f ->
                if (idx > 0) sb.append(',')
                sb.append(quote(f))
            }
            sb.append("\r\n")
        }
        return sb.toString()
    }

    fun quote(field: String): String {
        val needs = field.any { it == ',' || it == '"' || it == '\n' || it == '\r' }
        return if (needs) "\"" + field.replace("\"", "\"\"") + "\"" else field
    }

    fun readFile(file: File): List<List<String>> = parse(file.readText(Charsets.UTF_8))

    fun writeFile(file: File, rows: List<List<String>>) {
        file.parentFile?.mkdirs()
        file.writeText(format(rows), Charsets.UTF_8)
    }
}
