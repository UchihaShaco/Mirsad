package app.mirsad.core.ml

import app.mirsad.core.contract.Classifier
import app.mirsad.core.contract.NoopClassifier
import java.io.InputStream

/**
 * Stage-2 classifier: hashed character n-grams + word unigrams, logistic regression.
 * Pure Kotlin; inference is a few hundred hash computations and one sparse dot product.
 */
class ModelClassifier(private val model: LinearModel) : Classifier {
    override val modelVersion: String get() = model.modelVersion

    /** P(scam). The text is normalised again here (idempotent), so raw or pre-normalised input both work. */
    override fun scoreScam(normalisedText: String): Double {
        val text = normaliseForModel(normalisedText)
        if (text.isEmpty()) return 0.0
        val features = FeatureHasher.featurize(text, model.numBuckets)
        if (features.size == 0) return 0.0
        val z = model.bias + features.dot(model.weights)
        return sigmoid(z)
    }

    companion object {
        const val RESOURCE_PATH = "/model.bin"

        /** The model shipped in the assets, or [NoopClassifier] when it is missing or corrupt. Never throws. */
        fun loadDefault(): Classifier = loadResource(RESOURCE_PATH)

        fun loadResource(path: String): Classifier = try {
            val stream = ModelClassifier::class.java.getResourceAsStream(path) ?: return NoopClassifier
            stream.use { loadOrNoop(it) }
        } catch (_: Throwable) {
            NoopClassifier
        }

        /** Parses a model stream; returns [NoopClassifier] instead of throwing on any error. */
        fun loadOrNoop(input: InputStream): Classifier = try {
            load(input)
        } catch (_: Throwable) {
            NoopClassifier
        }

        /** Parses a model stream; throws on a corrupt file. */
        fun load(input: InputStream): ModelClassifier = ModelClassifier(ModelFormat.read(input))

        fun sigmoid(z: Double): Double {
            val c = z.coerceIn(-30.0, 30.0)
            return 1.0 / (1.0 + Math.exp(-c))
        }
    }
}
