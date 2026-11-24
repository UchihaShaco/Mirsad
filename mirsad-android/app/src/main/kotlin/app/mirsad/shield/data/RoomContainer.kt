package app.mirsad.shield.data

import android.content.Context
import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.report.DefaultReportBuilder
import app.mirsad.core.contract.FeedbackStore
import app.mirsad.core.contract.IncidentPipeline
import app.mirsad.core.contract.IncidentStore
import app.mirsad.core.contract.ListStore
import app.mirsad.core.contract.ReportBuilder
import app.mirsad.core.contract.ScamEngine
import app.mirsad.core.contract.SettingsStore
import app.mirsad.shield.AppContainer
import app.mirsad.shield.service.DefaultPipeline

/**
 * Production composition root: Room-backed stores, SharedPreferences settings, the real pipeline.
 * The engine comes from MirsadEngineFactory (workstream A), the report builder from workstream E.
 */
class RoomContainer(context: Context) : AppContainer {
    private val app = context.applicationContext
    private val db = AppDatabase.get(app)

    override val engine: ScamEngine = MirsadEngineFactory.create()
    override val incidents: IncidentStore = RoomIncidentStore(db)
    override val lists: ListStore = RoomListStore(db.listEntryDao())
    override val feedback: FeedbackStore = RoomFeedbackStore(db.feedbackDao())
    override val settings: SettingsStore = PrefsSettingsStore(app)
    override val reports: ReportBuilder = DefaultReportBuilder()
    override val pipeline: IncidentPipeline = DefaultPipeline(app, engine, incidents, lists, feedback, settings)

    /** Feedback rows as a CSV training set (Settings > Export). */
    val trainingExport: TrainingExport = TrainingExport(feedback, incidents)
}
