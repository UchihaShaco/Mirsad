package com.scamshield.guard

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/** Persistent settings. */
class Prefs(ctx: Context) {
    private val sp = ctx.applicationContext.getSharedPreferences("scamshield", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server_url", null) ?: BuildConfig.DEFAULT_SERVER_URL
        set(v) = sp.edit().putString("server_url", v.trim().trimEnd('/')).apply()

    var token: String
        get() = sp.getString("token", null) ?: BuildConfig.DEFAULT_DEVICE_TOKEN
        set(v) = sp.edit().putString("token", v.trim()).apply()

    /** User switched protection on. Service + boot receiver + worker all honour this. */
    var enabled: Boolean
        get() = sp.getBoolean("enabled", false)
        set(v) = sp.edit().putBoolean("enabled", v).apply()

    var lastVersion: Long
        get() = sp.getLong("last_version", -1)
        set(v) = sp.edit().putLong("last_version", v).apply()

    var lastCount: Int
        get() = sp.getInt("last_count", 0)
        set(v) = sp.edit().putInt("last_count", v).apply()

    var lastSyncAt: Long
        get() = sp.getLong("last_sync_at", 0)
        set(v) = sp.edit().putLong("last_sync_at", v).apply()

    val configured get() = serverUrl.isNotBlank() && token.isNotBlank()
}

/** In-process live status for the UI + notification. */
object Status {
    enum class Conn { OFF, CONNECTING, LIVE, ERROR }

    @Volatile var conn: Conn = Conn.OFF; private set
    @Volatile var detail: String = ""; private set
    @Volatile var lastResult: String = ""; private set

    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    fun set(c: Conn, d: String = "") { conn = c; detail = d; notifyAll() }
    fun result(r: String) { lastResult = r; notifyAll() }

    fun listen(l: () -> Unit) { listeners += l }
    fun unlisten(l: () -> Unit) { listeners -= l }
    private fun notifyAll() = main.post { listeners.forEach { it() } }
}
