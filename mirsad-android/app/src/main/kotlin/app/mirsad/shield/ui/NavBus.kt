package app.mirsad.shield.ui

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** A deep link or shared text handed from MainActivity (onCreate / onNewIntent) to the root composable. */
data class NavRequest(
    val incidentId: Long? = null,
    val screen: String? = null,
    val sharedText: String? = null,
    val nonce: Long = System.nanoTime(),
)

/** Same mailbox pattern as AutopilotBus: pending until consumed, never replayed. */
object NavBus {
    private val _pending = MutableStateFlow<NavRequest?>(null)
    val pending: StateFlow<NavRequest?> = _pending

    fun post(request: NavRequest) {
        _pending.value = request
    }

    fun consume(request: NavRequest) {
        _pending.compareAndSet(request, null)
    }
}
