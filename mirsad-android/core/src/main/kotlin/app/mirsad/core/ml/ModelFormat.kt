package app.mirsad.core.ml

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Logistic-regression weights over hashed features. */
class LinearModel(
    val modelVersion: String,
    val numBuckets: Int,
    val bias: Float,
    val weights: FloatArray,
) {
    init {
        require(weights.size == numBuckets) { "weights.size (${weights.size}) != numBuckets ($numBuckets)" }
    }
}

/**
 * Binary model file, little-endian:
 *
 *     magic "MRSD" (4 ASCII bytes) | formatVersion int32 | modelVersion: int32 length + UTF-8 bytes |
 *     numBuckets int32 | bias float32 | weights: numBuckets x float32
 */
object ModelFormat {
    const val FORMAT_VERSION = 1
    const val DEFAULT_MODEL_VERSION = "lr-ngram-v1"
    private val MAGIC = byteArrayOf('M'.code.toByte(), 'R'.code.toByte(), 'S'.code.toByte(), 'D'.code.toByte())
    private const val MAX_BUCKETS = 1 shl 22
    private const val MAX_VERSION_BYTES = 256

    fun write(model: LinearModel, out: OutputStream) {
        val versionBytes = model.modelVersion.toByteArray(Charsets.UTF_8)
        require(versionBytes.size <= MAX_VERSION_BYTES) { "modelVersion too long" }
        val size = 4 + 4 + 4 + versionBytes.size + 4 + 4 + 4 * model.numBuckets
        val buf = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)
        buf.put(MAGIC)
        buf.putInt(FORMAT_VERSION)
        buf.putInt(versionBytes.size)
        buf.put(versionBytes)
        buf.putInt(model.numBuckets)
        buf.putFloat(model.bias)
        buf.asFloatBuffer().put(model.weights)
        out.write(buf.array())
        out.flush()
    }

    /** Parses a model; throws [IOException] on any structural problem. */
    fun read(input: InputStream): LinearModel {
        val bytes = input.readBytes()
        return parse(bytes)
    }

    fun parse(bytes: ByteArray): LinearModel {
        if (bytes.size < 24) throw IOException("model file too short (${bytes.size} bytes)")
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = ByteArray(4)
        buf.get(magic)
        if (!magic.contentEquals(MAGIC)) throw IOException("bad magic")
        val formatVersion = buf.getInt()
        if (formatVersion != FORMAT_VERSION) throw IOException("unsupported format version $formatVersion")
        val versionLen = buf.getInt()
        if (versionLen < 0 || versionLen > MAX_VERSION_BYTES || versionLen > buf.remaining()) {
            throw IOException("bad modelVersion length $versionLen")
        }
        val versionBytes = ByteArray(versionLen)
        buf.get(versionBytes)
        val modelVersion = String(versionBytes, Charsets.UTF_8)
        if (buf.remaining() < 8) throw IOException("truncated header")
        val numBuckets = buf.getInt()
        if (numBuckets <= 0 || numBuckets > MAX_BUCKETS || (numBuckets and (numBuckets - 1)) != 0) {
            throw IOException("bad numBuckets $numBuckets")
        }
        val bias = buf.getFloat()
        if (buf.remaining() != 4 * numBuckets) {
            throw IOException("expected ${4 * numBuckets} weight bytes, found ${buf.remaining()}")
        }
        val weights = FloatArray(numBuckets)
        buf.asFloatBuffer().get(weights)
        if (bias.isNaN() || weights.any { it.isNaN() || it.isInfinite() }) throw IOException("non-finite weights")
        return LinearModel(modelVersion, numBuckets, bias, weights)
    }
}
