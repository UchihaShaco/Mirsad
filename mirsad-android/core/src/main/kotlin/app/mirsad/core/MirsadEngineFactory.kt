package app.mirsad.core

import app.mirsad.core.contract.Classifier
import app.mirsad.core.contract.FakeEngine
import app.mirsad.core.contract.NoopClassifier
import app.mirsad.core.contract.ScamEngine

/**
 * Single place that assembles the engine. The app and the tests call only this.
 * Workstream A replaces the body with the real stage-1 engine; the lead wires the trained
 * classifier (workstream B) in at M3.
 */
object MirsadEngineFactory {
    fun create(classifier: Classifier = defaultClassifier()): ScamEngine = FakeEngine(classifier)

    /** The classifier shipped in the assets, or Noop when no model is present. */
    fun defaultClassifier(): Classifier = NoopClassifier
}
