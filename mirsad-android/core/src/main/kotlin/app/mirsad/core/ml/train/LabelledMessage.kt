package app.mirsad.core.ml.train

import java.io.File

/** One row of the message CSVs: `label,lang,channel,sender,text,synthetic`. */
data class LabelledMessage(
    /** "scam" or "legit". */
    val label: String,
    /** "en", "ar" or "ar-latn" (Arabic in Latin letters). */
    val lang: String,
    /** "SMS" or "CHAT". */
    val channel: String,
    val sender: String,
    val text: String,
    val synthetic: Boolean = true,
) {
    val isScam: Boolean get() = label == LABEL_SCAM

    fun toRow(): List<String> = listOf(label, lang, channel, sender, text, synthetic.toString())

    companion object {
        const val LABEL_SCAM = "scam"
        const val LABEL_LEGIT = "legit"
        val HEADER = listOf("label", "lang", "channel", "sender", "text", "synthetic")

        fun fromRow(row: List<String>): LabelledMessage {
            require(row.size >= 5) { "expected at least 5 columns, got ${row.size}: $row" }
            return LabelledMessage(
                label = row[0].trim().lowercase(),
                lang = row[1].trim().lowercase(),
                channel = row[2].trim().uppercase(),
                sender = row[3].trim(),
                text = row[4],
                synthetic = row.getOrNull(5)?.trim()?.equals("true", ignoreCase = true) ?: true,
            )
        }

        /** Reads a CSV with the standard header; extra columns (e.g. `source`) are ignored. */
        fun readCsv(file: File): List<LabelledMessage> {
            val rows = Csv.readFile(file)
            if (rows.isEmpty()) return emptyList()
            val header = rows.first().map { it.trim().lowercase() }
            require(header.take(HEADER.size) == HEADER) { "unexpected header in ${file.name}: $header" }
            return rows.drop(1).filter { r -> r.any { it.isNotBlank() } }.map { fromRow(it) }
        }

        fun writeCsv(file: File, messages: List<LabelledMessage>) {
            Csv.writeFile(file, listOf(HEADER) + messages.map { it.toRow() })
        }
    }
}
