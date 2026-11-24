package app.mirsad.shield.data

import app.mirsad.core.contract.ListEntry
import app.mirsad.core.contract.ListKind
import app.mirsad.core.contract.ListStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class RoomListStore(private val dao: ListEntryDao) : ListStore {
    /** Adds the entry, or returns the id of the existing row when (kind, value) is already listed. */
    override suspend fun add(entry: ListEntry): Long {
        val id = dao.insert(entry.copy(id = 0).toEntity())
        return if (id > 0) id else dao.findId(entry.kind.name, entry.value) ?: -1L
    }

    override suspend fun remove(id: Long) = dao.delete(id)

    override suspend fun removeValue(kind: ListKind, value: String) = dao.deleteValue(kind.name, value)

    override suspend fun contains(kind: ListKind, value: String): Boolean = dao.count(kind.name, value) > 0

    override fun observe(kind: ListKind): Flow<List<ListEntry>> =
        dao.observe(kind.name).map { rows -> rows.map(ListEntryEntity::toListEntry) }

    override suspend fun values(kind: ListKind): Set<String> = dao.values(kind.name).toSet()

    override suspend fun deleteAll() = dao.deleteAll()
}
