package app.mirsad.shield.data

import app.mirsad.core.contract.Feedback
import app.mirsad.core.contract.FeedbackStore
import app.mirsad.core.contract.FeedbackVerdict

/** FeedbackStore plus the one extra operation the pipeline needs to undo "Not a scam". */
interface UndoableFeedbackStore : FeedbackStore {
    /** Deletes the feedback rows of [incidentId] with the given [verdict]. */
    suspend fun removeForIncident(incidentId: Long, verdict: FeedbackVerdict)
}

class RoomFeedbackStore(private val dao: FeedbackDao) : UndoableFeedbackStore {
    override suspend fun add(feedback: Feedback): Long = dao.insert(feedback.copy(id = 0).toEntity())

    override suspend fun all(): List<Feedback> = dao.all().map(FeedbackEntity::toFeedback)

    override suspend fun deleteAll() = dao.deleteAll()

    override suspend fun removeForIncident(incidentId: Long, verdict: FeedbackVerdict) =
        dao.deleteForIncident(incidentId, verdict.name)
}
