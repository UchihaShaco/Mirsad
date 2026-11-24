package app.mirsad.shield.demo

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Process-wide mailbox for the debug autopilot (adb broadcast -> AutopilotReceiver -> post -> root composable).
 * A step stays pending until the root consumes it, so a step posted while the activity is starting is not lost,
 * and a consumed step is never replayed after a recreation.
 */
object AutopilotBus {
    data class Step(val name: String, val nonce: Long = System.nanoTime())

    private val _pending = MutableStateFlow<Step?>(null)
    val pending: StateFlow<Step?> = _pending

    /** True while the root composable is collecting; the receiver starts MainActivity otherwise. */
    val hasListener: Boolean get() = _pending.subscriptionCount.value > 0

    fun post(name: String) {
        _pending.value = Step(name.trim().lowercase())
    }

    fun consume(step: Step) {
        _pending.compareAndSet(step, null)
    }

    /** Every step name the root understands, for the receiver's usage text. */
    val STEPS = listOf(
        "home", "demo", "demo_scam", "incident", "restore", "call", "report",
        "quarantine", "settings", "onboarding", "lang_ar", "lang_en",
    )

    // Android 10+ blocks activity starts from a background receiver (BAL_BLOCK), and the process may die before
    // the activity is started by hand. A step posted with no listener is therefore also written to disk and
    // picked up by MainActivity.onCreate (see takePersisted).
    private const val PREFS = "mirsad_autopilot"
    private const val KEY = "pending_step"

    fun persist(context: android.content.Context, name: String) {
        context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit().putString(KEY, name).apply()
    }

    /** Returns and clears a persisted step, or null. Cheap: one SharedPreferences read at activity start. */
    fun takePersisted(context: android.content.Context): String? {
        val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        val step = prefs.getString(KEY, null) ?: return null
        prefs.edit().remove(KEY).apply()
        return step
    }
}
