package app.mirsad.shield

import app.mirsad.core.contract.FeedbackStore
import app.mirsad.core.contract.IncidentPipeline
import app.mirsad.core.contract.IncidentStore
import app.mirsad.core.contract.ListStore
import app.mirsad.core.contract.ReportBuilder
import app.mirsad.core.contract.ScamEngine
import app.mirsad.core.contract.SettingsStore

/**
 * Composition root contract. The UI (workstream C) reads everything through this interface.
 * Workstream D provides the Room-backed implementation and installs it in MirsadApp.
 * Until then InMemoryContainer (bootstrap package) keeps the app runnable.
 */
interface AppContainer {
    val engine: ScamEngine
    val incidents: IncidentStore
    val lists: ListStore
    val feedback: FeedbackStore
    val settings: SettingsStore
    val pipeline: IncidentPipeline
    val reports: ReportBuilder
}
