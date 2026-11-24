package app.mirsad.core.ml.train

import app.mirsad.core.ml.FeatureHasher
import app.mirsad.core.ml.LinearModel
import app.mirsad.core.ml.ModelClassifier
import app.mirsad.core.ml.SparseVector
import app.mirsad.core.ml.normaliseForModel
import kotlin.random.Random

/** A featurised training example; [label] is 1.0 for scam and 0.0 for legit. */
class Sample(val features: SparseVector, val label: Double)

/**
 * L2-regularised logistic regression trained by per-sample SGD with a deterministic seed.
 * The L2 shrinkage is applied lazily through a global scale factor so each step touches only the
 * non-zero features of the sample.
 */
class LogisticRegressionTrainer(
    private val numBuckets: Int = FeatureHasher.NUM_BUCKETS,
    private val epochs: Int = 60,
    private val learningRate: Double = 0.5,
    private val l2: Double = 1e-5,
    /** Gradient weight of legitimate samples; above 1 trades recall for fewer false positives. */
    private val legitWeight: Double = 2.0,
    private val seed: Int = 42,
    private val modelVersion: String = "lr-ngram-v1",
) {
    fun train(samples: List<Sample>, log: (String) -> Unit = {}): LinearModel {
        require(samples.isNotEmpty()) { "no training samples" }
        val w = DoubleArray(numBuckets)
        var scale = 1.0
        var bias = 0.0
        val rnd = Random(seed)
        val order = samples.indices.toMutableList()

        for (epoch in 0 until epochs) {
            order.shuffle(rnd)
            val lr = learningRate / (1.0 + epoch / 6.0)
            var loss = 0.0
            for (idx in order) {
                val s = samples[idx]
                val x = s.features
                var z = bias
                for (k in x.indices.indices) z += scale * w[x.indices[k]] * x.values[k]
                val p = ModelClassifier.sigmoid(z)
                loss -= if (s.label > 0.5) Math.log(p.coerceAtLeast(1e-12)) else Math.log((1 - p).coerceAtLeast(1e-12))
                val g = (p - s.label) * (if (s.label > 0.5) 1.0 else legitWeight)

                scale *= (1.0 - lr * l2)
                if (scale < 1e-6) {
                    for (i in w.indices) w[i] *= scale
                    scale = 1.0
                }
                val step = lr * g / scale
                for (k in x.indices.indices) w[x.indices[k]] -= step * x.values[k]
                bias -= lr * g
            }
            if ((epoch + 1) % 10 == 0 || epoch == 0 || epoch == epochs - 1) {
                log("epoch ${epoch + 1}/$epochs lr=%.4f loss=%.4f".format(lr, loss / samples.size))
            }
        }
        val weights = FloatArray(numBuckets) { (w[it] * scale).toFloat() }
        return LinearModel(modelVersion, numBuckets, bias.toFloat(), weights)
    }

    companion object {
        fun toSample(message: LabelledMessage, numBuckets: Int = FeatureHasher.NUM_BUCKETS): Sample =
            Sample(FeatureHasher.featurize(normaliseForModel(message.text), numBuckets), if (message.isScam) 1.0 else 0.0)
    }
}
