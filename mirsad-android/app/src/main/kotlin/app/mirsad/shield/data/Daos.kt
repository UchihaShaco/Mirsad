package app.mirsad.shield.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface IncidentDao {
    @Insert
    suspend fun insert(incident: IncidentEntity): Long

    @Update
    suspend fun update(incident: IncidentEntity)

    @Query("SELECT * FROM incidents WHERE id = :id")
    suspend fun get(id: Long): IncidentEntity?

    @Query("SELECT * FROM incidents ORDER BY createdAt DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<IncidentEntity>>

    /** Enum filters are passed by name (Room stores enums as their names). Null means "any". */
    @Query(
        "SELECT * FROM incidents WHERE (:includeAllowed OR level != 'ALLOW') " +
            "AND (:channel IS NULL OR channel = :channel) AND (:level IS NULL OR level = :level) " +
            "ORDER BY createdAt DESC",
    )
    fun observe(includeAllowed: Boolean, channel: String?, level: String?): Flow<List<IncidentEntity>>

    @Query("SELECT COUNT(*) FROM incidents WHERE level != 'ALLOW' AND createdAt >= :since")
    suspend fun countFlagged(since: Long): Int

    // Real held messages only: not calls (a held call must not renew its own rule), not demo incidents, and not
    // incidents the user marked "Not a scam".
    @Query(
        "SELECT DISTINCT sender FROM incidents WHERE level = 'HOLD' AND senderType = 'NUMBER' AND channel != 'CALL' " +
            "AND synthetic = 0 AND feedback != 'FALSE_POSITIVE' AND createdAt >= :since",
    )
    suspend fun heldNumbersSince(since: Long): List<String>

    @Query("DELETE FROM incidents WHERE createdAt < :epochMillis")
    suspend fun deleteOlderThan(epochMillis: Long)

    @Query("DELETE FROM incidents")
    suspend fun deleteAll()
}

@Dao
interface ArtifactDao {
    @Insert
    suspend fun insertAll(artifacts: List<ArtifactEntity>)

    @Query("DELETE FROM artifacts WHERE incidentId = :incidentId")
    suspend fun deleteForIncident(incidentId: Long)

    /** Incidents that carried this artifact (e.g. all incidents mentioning a domain), newest first. */
    @Query("SELECT DISTINCT incidentId FROM artifacts WHERE type = :type AND `value` = :value ORDER BY incidentId DESC")
    suspend fun incidentIdsFor(type: String, value: String): List<Long>

    @Query("DELETE FROM artifacts WHERE incidentId NOT IN (SELECT id FROM incidents)")
    suspend fun deleteOrphans()

    @Query("DELETE FROM artifacts")
    suspend fun deleteAll()
}

@Dao
interface ListEntryDao {
    /** Returns -1 when the (kind, value) pair already exists; the existing row is kept untouched. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entry: ListEntryEntity): Long

    @Query("SELECT id FROM list_entries WHERE kind = :kind AND `value` = :value LIMIT 1")
    suspend fun findId(kind: String, value: String): Long?

    @Query("DELETE FROM list_entries WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("DELETE FROM list_entries WHERE kind = :kind AND `value` = :value")
    suspend fun deleteValue(kind: String, value: String)

    @Query("SELECT COUNT(*) FROM list_entries WHERE kind = :kind AND `value` = :value")
    suspend fun count(kind: String, value: String): Int

    @Query("SELECT * FROM list_entries WHERE kind = :kind ORDER BY createdAt DESC")
    fun observe(kind: String): Flow<List<ListEntryEntity>>

    @Query("SELECT `value` FROM list_entries WHERE kind = :kind")
    suspend fun values(kind: String): List<String>

    @Query("DELETE FROM list_entries")
    suspend fun deleteAll()
}

@Dao
interface FeedbackDao {
    @Insert
    suspend fun insert(feedback: FeedbackEntity): Long

    @Query("SELECT * FROM feedback ORDER BY createdAt ASC")
    suspend fun all(): List<FeedbackEntity>

    @Query("DELETE FROM feedback WHERE incidentId = :incidentId AND verdict = :verdict")
    suspend fun deleteForIncident(incidentId: Long, verdict: String)

    @Query("DELETE FROM feedback")
    suspend fun deleteAll()
}
