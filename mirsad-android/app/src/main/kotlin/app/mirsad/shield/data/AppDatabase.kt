package app.mirsad.shield.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/** Local-only database. Nothing in it ever leaves the phone unless the user shares a report. */
@Database(
    entities = [IncidentEntity::class, ArtifactEntity::class, ListEntryEntity::class, FeedbackEntity::class],
    version = 1,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun incidentDao(): IncidentDao
    abstract fun artifactDao(): ArtifactDao
    abstract fun listEntryDao(): ListEntryDao
    abstract fun feedbackDao(): FeedbackDao

    companion object {
        const val NAME = "mirsad.db"

        @Volatile
        private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, NAME)
                // Hackathon prototype: a schema bump recreates the database instead of migrating.
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
                .also { instance = it }
        }
    }
}
