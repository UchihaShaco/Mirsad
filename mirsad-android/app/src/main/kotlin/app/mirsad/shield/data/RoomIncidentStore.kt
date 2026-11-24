package app.mirsad.shield.data

import androidx.room.withTransaction
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentFilter
import app.mirsad.core.contract.IncidentStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class RoomIncidentStore(private val db: AppDatabase) : IncidentStore {
    private val incidents = db.incidentDao()
    private val artifacts = db.artifactDao()

    override suspend fun insert(incident: Incident): Long = db.withTransaction {
        val id = incidents.insert(incident.copy(id = 0).toEntity())
        val rows = incident.artifactEntities(id)
        if (rows.isNotEmpty()) artifacts.insertAll(rows)
        id
    }

    override suspend fun get(id: Long): Incident? = incidents.get(id)?.toIncident()

    override suspend fun update(incident: Incident) = db.withTransaction {
        incidents.update(incident.toEntity())
        artifacts.deleteForIncident(incident.id)
        val rows = incident.artifactEntities()
        if (rows.isNotEmpty()) artifacts.insertAll(rows)
    }

    override fun observeRecent(limit: Int): Flow<List<Incident>> =
        incidents.observeRecent(limit).map { rows -> rows.map(IncidentEntity::toIncident) }

    override fun observe(filter: IncidentFilter): Flow<List<Incident>> =
        incidents.observe(filter.includeAllowed, filter.channel?.name, filter.level?.name)
            .map { rows -> rows.map(IncidentEntity::toIncident) }

    override suspend fun countFlagged(sinceEpochMillis: Long): Int = incidents.countFlagged(sinceEpochMillis)

    override suspend fun heldNumbersSince(sinceEpochMillis: Long): Set<String> =
        incidents.heldNumbersSince(sinceEpochMillis).toSet()

    override suspend fun purgeOlderThan(epochMillis: Long) = db.withTransaction {
        incidents.deleteOlderThan(epochMillis)
        artifacts.deleteOrphans()
    }

    override suspend fun deleteAll() = db.withTransaction {
        incidents.deleteAll()
        artifacts.deleteAll()
    }
}
