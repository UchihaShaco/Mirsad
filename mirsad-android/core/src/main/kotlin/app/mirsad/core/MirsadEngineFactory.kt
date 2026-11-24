package app.mirsad.core

import app.mirsad.core.contract.Classifier
import app.mirsad.core.contract.ScamEngine
import app.mirsad.core.engine.MirsadEngine
import app.mirsad.core.ml.ModelClassifier

/**
 * Single place that assembles the engine. The app and the tests call only this.
 * Stage 1 is [MirsadEngine] (rules + reputation, workstream A); stage 2 is the hashed n-gram
 * classifier from the assets (workstream B), or Noop when no model is present.
 */
object MirsadEngineFactory {
    fun create(classifier: Classifier = defaultClassifier()): ScamEngine = MirsadEngine.create(classifier)

    /** The classifier shipped in the assets, or Noop when no model is present. Never throws. */
    fun defaultClassifier(): Classifier = ModelClassifier.loadDefault()
}
