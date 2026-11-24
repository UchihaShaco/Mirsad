package app.mirsad.shield

import android.app.Application
import android.util.Log
import app.mirsad.shield.data.RoomContainer
import app.mirsad.shield.service.Notices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Room-backed container, notification channels, 30-day Quarantine retention. */
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
            // Self-check: Android's ICU regex engine is stricter than the JVM's; a refused rule pattern would
            // silently switch a rule off, so log it loudly.
            val probe = container.engine.analyse(
                app.mirsad.core.contract.Event(app.mirsad.core.contract.Channel.SMS, "x", "self check", null, 0L, false),
            )
            val rejected = app.mirsad.core.engine.RuleSet.rejectedPatterns
            if (rejected.isEmpty()) Log.i(TAG, "rules ${probe.rulesVersion} loaded, all patterns compiled, model ${probe.modelVersion}")
            else Log.e(TAG, "rules ${probe.rulesVersion}: ${rejected.size} patterns refused by this device: $rejected")
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
