package app.mirsad.core.ml

import app.mirsad.core.ml.train.LabelledMessage
import java.io.File

/** Locates the repository `data/` folder from the test working directory (Gradle runs tests in `core/`). */
object TestData {
    val dataDir: File by lazy {
        listOf(File("../data"), File("data"), File("mirsad-android/data"))
            .firstOrNull { File(it, "seed_messages.csv").isFile }
            ?.canonicalFile
            ?: error("data folder not found from ${File(".").canonicalPath}")
    }

    val seeds: List<LabelledMessage> by lazy { LabelledMessage.readCsv(File(dataDir, "seed_messages.csv")) }
    val legitSuite: List<LabelledMessage> by lazy { LabelledMessage.readCsv(File(dataDir, "legit_suite.csv")) }
}
