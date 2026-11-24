package app.mirsad.core.ml.train

import app.mirsad.core.contract.Classifier

/** Binary classification metrics at a fixed threshold. Positive class = scam. */
data class Evaluation(
    val truePositives: Int,
    val falsePositives: Int,
    val falseNegatives: Int,
    val trueNegatives: Int,
    val threshold: Double,
) {
    val total: Int get() = truePositives + falsePositives + falseNegatives + trueNegatives
    val precision: Double get() = safeDiv(truePositives, truePositives + falsePositives)
    val recall: Double get() = safeDiv(truePositives, truePositives + falseNegatives)
    val f1: Double get() = if (precision + recall == 0.0) 0.0 else 2 * precision * recall / (precision + recall)
    val accuracy: Double get() = safeDiv(truePositives + trueNegatives, total)

    fun summary(): String = buildString {
        appendLine("threshold=%.2f  n=%d".format(threshold, total))
        appendLine("precision=%.4f  recall=%.4f  f1=%.4f  accuracy=%.4f".format(precision, recall, f1, accuracy))
        appendLine("confusion matrix (rows = actual, columns = predicted):")
        appendLine("               pred scam   pred legit")
        appendLine("actual scam    %9d   %10d".format(truePositives, falseNegatives))
        appendLine("actual legit   %9d   %10d".format(falsePositives, trueNegatives))
    }

    fun markdownTable(): String = buildString {
        appendLine("| Metric | Value |")
        appendLine("|---|---|")
        appendLine("| Precision | %.4f |".format(precision))
        appendLine("| Recall | %.4f |".format(recall))
        appendLine("| F1 | %.4f |".format(f1))
        appendLine("| Accuracy | %.4f |".format(accuracy))
        appendLine("| Held-out rows | $total |")
        appendLine()
        appendLine("Confusion matrix at threshold %.2f (rows = actual, columns = predicted):".format(threshold))
        appendLine()
        appendLine("| | Predicted scam | Predicted legit |")
        appendLine("|---|---|---|")
        appendLine("| Actual scam | $truePositives | $falseNegatives |")
        appendLine("| Actual legit | $falsePositives | $trueNegatives |")
    }

    private fun safeDiv(a: Int, b: Int): Double = if (b == 0) 0.0 else a.toDouble() / b

    companion object {
        fun of(classifier: Classifier, rows: List<LabelledMessage>, threshold: Double = 0.5): Evaluation {
            var tp = 0
            var fp = 0
            var fn = 0
            var tn = 0
            for (row in rows) {
                val predictedScam = classifier.scoreScam(row.text) >= threshold
                when {
                    row.isScam && predictedScam -> tp++
                    row.isScam -> fn++
                    predictedScam -> fp++
                    else -> tn++
                }
            }
            return Evaluation(tp, fp, fn, tn, threshold)
        }
    }
}
