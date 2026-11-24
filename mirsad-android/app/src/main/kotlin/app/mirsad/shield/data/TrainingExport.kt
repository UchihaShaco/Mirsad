package app.mirsad.shield.data

import app.mirsad.core.contract.FeedbackStore
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.IncidentStore

/**
 * Turns feedback rows into labelled CSV rows: `label,lang,channel,sender,text,synthetic,source`.
 * label = legit for FALSE_POSITIVE, scam for CONFIRMED_SCAM. The sender column is always blank.
 * Only the user decides to share the result (nothing is uploaded).
 */
class TrainingExport(private val feedback: FeedbackStore, private val incidents: IncidentStore) {
    suspend fun exportCsv(): String {
        val out = StringBuilder(HEADER).append('\n')
        for (row in feedback.all()) {
            val label = when (row.verdict) {
                FeedbackVerdict.FALSE_POSITIVE -> "legit"
                FeedbackVerdict.CONFIRMED_SCAM -> "scam"
                FeedbackVerdict.NONE -> continue
            }
            val incident = incidents.get(row.incidentId)
            val fields = listOf(
                label,
                row.language.name.lowercase(),
                incident?.channel?.name?.lowercase().orEmpty(),
                "",
                row.text.orEmpty(),
                (incident?.synthetic ?: false).toString(),
                incident?.source?.name?.lowercase().orEmpty(),
            )
            out.append(fields.joinToString(",") { csvField(it) }).append('\n')
        }
        return out.toString()
    }

    private fun csvField(value: String): String =
        if (value.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) {
            "\"" + value.replace("\"", "\"\"") + "\""
        } else {
            value
        }

    companion object {
        const val HEADER = "label,lang,channel,sender,text,synthetic,source"
    }
}
