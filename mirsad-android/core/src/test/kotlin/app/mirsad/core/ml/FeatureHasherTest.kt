package app.mirsad.core.ml

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class FeatureHasherTest {
    @Test
    fun `fnv1a matches published test vectors`() {
        assertEquals(0x811C9DC5.toInt(), Fnv1a.hashBytes(ByteArray(0)))
        assertEquals(0xE40C292C.toInt(), Fnv1a.hashBytes("a".toByteArray()))
        assertEquals(0xBF9CF968.toInt(), Fnv1a.hashBytes("foobar".toByteArray()))
    }

    @Test
    fun `features are deterministic, in range, unique and unit length`() {
        val text = normaliseForModel("Your OTP is 482913 for a purchase of AED 120.00 at CARREFOUR. Do not share this code.")
        val a = FeatureHasher.featurize(text)
        val b = FeatureHasher.featurize(text)
        assertContentEquals(a.indices, b.indices)
        assertContentEquals(a.values, b.values)
        assertTrue(a.size > 50)
        assertTrue(a.indices.all { it in 0 until FeatureHasher.NUM_BUCKETS })
        assertEquals(a.indices.size, a.indices.toSet().size)
        val norm = Math.sqrt(a.values.sumOf { it.toDouble() * it })
        assertEquals(1.0, norm, 1e-4)
    }

    @Test
    fun `different texts give different vectors and empty text gives nothing`() {
        val a = FeatureHasher.featurize("pay the fee now")
        val b = FeatureHasher.featurize("dinner at eight")
        assertNotEquals(a.indices.toSet(), b.indices.toSet())
        assertEquals(0, FeatureHasher.featurize("").size)
        assertEquals(0, FeatureHasher.featurize("   ").size)
    }

    @Test
    fun `smaller bucket counts are honoured`() {
        val v = FeatureHasher.featurize("hello world", 1 shl 10)
        assertTrue(v.indices.all { it in 0 until 1024 })
    }
}
