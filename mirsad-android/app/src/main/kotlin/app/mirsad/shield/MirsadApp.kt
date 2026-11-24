package app.mirsad.shield

import android.app.Application
import android.util.Log
import app.mirsad.shield.data.RoomContainer
import app.mirsad.shield.service.Notices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Owned by workstream D: Room-backed container, notification channels, 30-day Quarantine retention. */
class MirsadApp : Application() {
    lateinit var container: AppContainer
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        Notices.createChannels(this)
        container = RoomContainer(this)
        appScope.launch {
            runCatching { container.incidents.purgeOlderThan(System.currentTimeMillis() - RETENTION_MS) }
                .onFailure { Log.w(TAG, "quarantine purge failed", it) }
        }
    }

    companion object {
        private const val TAG = "MirsadApp"
        const val RETENTION_DAYS = 30L
        private const val RETENTION_MS = RETENTION_DAYS * 24 * 3600 * 1000

        fun container(context: android.content.Context): AppContainer =
            (context.applicationContext as MirsadApp).container
    }
}
