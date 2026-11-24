package app.mirsad.core.ml

/** A sparse feature vector: parallel arrays of bucket indices and values, indices unique. */
class SparseVector(val indices: IntArray, val values: FloatArray) {
    val size: Int get() = indices.size

    /** Dot product with a dense weight vector. */
    fun dot(weights: FloatArray): Double {
        var acc = 0.0
        for (k in indices.indices) acc += weights[indices[k]] * values[k]
        return acc
    }

    companion object {
        val EMPTY = SparseVector(IntArray(0), FloatArray(0))
    }
}

/**
 * FNV-1a (32-bit) over bytes, followed by the MurmurHash3 fmix32 finaliser so the low bits used as bucket
 * index are well mixed. Fixed and platform-independent; never use String.hashCode for features.
 */
object Fnv1a {
    const val OFFSET_BASIS: Int = 0x811C9DC5.toInt()
    const val PRIME: Int = 0x01000193

    /** Plain FNV-1a 32 over a byte array (no finaliser); matches the published test vectors. */
    fun hashBytes(bytes: ByteArray): Int {
        var h = OFFSET_BASIS
        for (b in bytes) h = (h xor (b.toInt() and 0xFF)) * PRIME
        return h
    }

    /** FNV-1a over the UTF-16LE bytes of s[start, end), starting from [seed], then fmix32. */
    fun hashChars(seed: Int, s: CharSequence, start: Int, end: Int): Int {
        var h = seed
        for (i in start until end) {
            val c = s[i].code
            h = (h xor (c and 0xFF)) * PRIME
            h = (h xor (c ushr 8)) * PRIME
        }
        return fmix32(h)
    }

    fun fmix32(input: Int): Int {
        var h = input
        h = h xor (h ushr 16)
        h *= 0x85EBCA6B.toInt()
        h = h xor (h ushr 13)
        h *= 0xC2B2AE35.toInt()
        h = h xor (h ushr 16)
        return h
    }
}

/**
 * Hashed features over text already passed through [normaliseForModel]:
 * character n-grams (2..5, with word-boundary spaces) and word unigrams, each namespace with its own seed,
 * signed hashing into [numBuckets] buckets, then L2-normalised counts.
 */
object FeatureHasher {
    const val NUM_BUCKETS: Int = 1 shl 18
    const val MIN_N = 2
    const val MAX_N = 5

    private const val WORD_SEED = Fnv1a.OFFSET_BASIS xor 0x5A5A5A5A
    private val CHAR_SEEDS = IntArray(MAX_N + 1) { n -> Fnv1a.OFFSET_BASIS xor (0x1F1F1F1F * (n + 1)) }

    fun featurize(normalisedText: String, numBuckets: Int = NUM_BUCKETS): SparseVector {
        require(numBuckets > 0 && (numBuckets and (numBuckets - 1)) == 0) { "numBuckets must be a power of two" }
        if (normalisedText.isBlank()) return SparseVector.EMPTY
        val mask = numBuckets - 1
        val counts = HashMap<Int, Float>(normalisedText.length * 4)

        val padded = " $normalisedText "
        for (n in MIN_N..MAX_N) {
            val seed = CHAR_SEEDS[n]
            var i = 0
            val last = padded.length - n
            while (i <= last) {
                add(counts, Fnv1a.hashChars(seed, padded, i, i + n), mask)
                i++
            }
        }
        var start = 0
        val len = normalisedText.length
        while (start < len) {
            while (start < len && normalisedText[start] == ' ') start++
            if (start >= len) break
            var end = start
            while (end < len && normalisedText[end] != ' ') end++
            add(counts, Fnv1a.hashChars(WORD_SEED, normalisedText, start, end), mask)
            start = end
        }
        if (counts.isEmpty()) return SparseVector.EMPTY

        var norm = 0.0
        for (v in counts.values) norm += v.toDouble() * v
        val inv = (1.0 / Math.sqrt(norm)).toFloat()
        val indices = IntArray(counts.size)
        val values = FloatArray(counts.size)
        var k = 0
        for ((idx, v) in counts) {
            indices[k] = idx
            values[k] = v * inv
            k++
        }
        return SparseVector(indices, values)
    }

    private fun add(counts: HashMap<Int, Float>, hash: Int, mask: Int) {
        val idx = hash and mask
        val sign = if (hash < 0) -1f else 1f
        counts[idx] = (counts[idx] ?: 0f) + sign
    }
}
