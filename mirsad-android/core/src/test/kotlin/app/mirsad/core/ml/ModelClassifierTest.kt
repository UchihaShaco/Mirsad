package app.mirsad.core.ml

import app.mirsad.core.contract.NoopClassifier
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ModelClassifierTest {
    private val classifier = ModelClassifier.loadDefault()

    @Test
    fun `the shipped model loads from the classpath`() {
        assertIs<ModelClassifier>(classifier, "model.bin missing or corrupt: run ./gradlew :core:trainModel")
        assertEquals(ModelFormat.DEFAULT_MODEL_VERSION, classifier.modelVersion)
    }

    @Test
    fun `scam seeds score above a half on average`() {
        val scores = TestData.seeds.filter { it.isScam }.map { classifier.scoreScam(it.text) }
        val mean = scores.average()
        println("scam seeds: mean=%.3f min=%.3f".format(mean, scores.min()))
        assertTrue(mean > 0.5, "mean scam score $mean")
    }

    @Test
    fun `legit seeds and the legit suite score below a half on average`() {
        val seedScores = TestData.seeds.filter { !it.isScam }.map { classifier.scoreScam(it.text) }
        val suiteScores = TestData.legitSuite.map { it to classifier.scoreScam(it.text) }
        println("legit seeds: mean=%.3f max=%.3f".format(seedScores.average(), seedScores.max()))
        println("legit suite: mean=%.3f max=%.3f, rows >= 0.5: %d of %d, rows >= 0.3: %d".format(
            suiteScores.map { it.second }.average(), suiteScores.maxOf { it.second },
            suiteScores.count { it.second >= 0.5 }, suiteScores.size, suiteScores.count { it.second >= 0.3 }))
        suiteScores.filter { it.second >= 0.3 }.forEach { (row, s) -> println("  model >= 0.3 (%.3f) %s: %s".format(s, row.sender, row.text)) }
        suiteScores.filter { it.second >= 0.5 }.forEach { (row, s) -> println("  model flags (%.3f) %s: %s".format(s, row.sender, row.text)) }
        assertTrue(seedScores.average() < 0.5, "mean legit seed score ${seedScores.average()}")
        assertTrue(suiteScores.map { it.second }.average() < 0.5, "mean legit suite score")
    }

    @Test
    fun `scores are in range and identical for raw and pre-normalised text`() {
        for (row in TestData.seeds + TestData.legitSuite) {
            val raw = classifier.scoreScam(row.text)
            val normalised = classifier.scoreScam(normaliseForModel(row.text))
            assertTrue(raw in 0.0..1.0)
            assertEquals(raw, normalised, 1e-9, "normalisation changed the score for: ${row.text}")
        }
        assertEquals(0.0, classifier.scoreScam(""))
        assertEquals(0.0, classifier.scoreScam("   "))
    }

    @Test
    fun `normaliseForModel is idempotent`() {
        for (row in TestData.seeds + TestData.legitSuite) {
            val once = normaliseForModel(row.text)
            assertEquals(once, normaliseForModel(once))
        }
    }

    @Test
    fun `inference stays under five milliseconds per text`() {
        val texts = (TestData.seeds + TestData.legitSuite).map { it.text }
        repeat(30) { texts.forEach { classifier.scoreScam(it) } } // warm-up
        val rounds = 50
        val start = System.nanoTime()
        repeat(rounds) { texts.forEach { classifier.scoreScam(it) } }
        val perTextMs = (System.nanoTime() - start) / 1e6 / (rounds * texts.size)
        println("inference: %.3f ms per text".format(perTextMs))
        assertTrue(perTextMs < 5.0, "inference too slow: $perTextMs ms per text")
    }

    @Test
    fun `model format round trips`() {
        val weights = FloatArray(1 shl 10) { (it % 7 - 3) * 0.25f }
        val model = LinearModel("lr-test", 1 shl 10, -0.5f, weights)
        val bytes = ByteArrayOutputStream().also { ModelFormat.write(model, it) }.toByteArray()
        assertEquals(4 + 4 + 4 + "lr-test".length + 4 + 4 + 4 * 1024, bytes.size)
        assertEquals("MRSD", String(bytes, 0, 4, Charsets.US_ASCII))
        val parsed = ModelFormat.parse(bytes)
        assertEquals("lr-test", parsed.modelVersion)
        assertEquals(1 shl 10, parsed.numBuckets)
        assertEquals(-0.5f, parsed.bias)
        assertContentEquals(weights, parsed.weights)
    }

    @Test
    fun `missing or corrupt models fall back to noop without throwing`() {
        assertSame(NoopClassifier, ModelClassifier.loadResource("/does-not-exist.bin"))
        assertSame(NoopClassifier, ModelClassifier.loadOrNoop(ByteArrayInputStream(ByteArray(0))))
        assertSame(NoopClassifier, ModelClassifier.loadOrNoop(ByteArrayInputStream("not a model at all".toByteArray())))
        val good = ByteArrayOutputStream().also { ModelFormat.write(LinearModel("v", 1 shl 8, 0f, FloatArray(1 shl 8)), it) }.toByteArray()
        assertSame(NoopClassifier, ModelClassifier.loadOrNoop(ByteArrayInputStream(good.copyOf(good.size - 10))))
        val badMagic = good.copyOf().also { it[0] = 'X'.code.toByte() }
        assertSame(NoopClassifier, ModelClassifier.loadOrNoop(ByteArrayInputStream(badMagic)))
        assertIs<ModelClassifier>(ModelClassifier.loadOrNoop(ByteArrayInputStream(good)))
    }
}
