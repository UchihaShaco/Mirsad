package com.scamshield.guard

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Foreground service that keeps a WebSocket open to the sync server. The server pushes a full
 * snapshot on connect and on every change, so flag/unflag on the dashboard reaches the phone's
 * contacts in about a second. Reconnects with backoff and immediately when the network returns.
 */
class GuardService : Service() {

    companion object {
        private const val TAG = "GuardService"
        const val CHANNEL = "protection"
        private const val NOTIF_ID = 1
        private const val ACTION_RECONNECT = "reconnect"

        fun start(ctx: Context) {
            val i = Intent(ctx, GuardService::class.java)
            try {
                ctx.startForegroundService(i)
            } catch (e: Exception) {
                // Android 12+ may refuse background FGS starts; the periodic worker will keep contacts in sync anyway.
                Log.w(TAG, "could not start service: $e")
            }
        }

        fun reconnect(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, GuardService::class.java).setAction(ACTION_RECONNECT))
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, GuardService::class.java))
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private var socket: WebSocket? = null
    private var generation = 0      // ignores callbacks from sockets we've already abandoned
    private var backoffMs = 1_000L
    private var stopped = false

    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post { if (Status.conn != Status.Conn.LIVE) { backoffMs = 1_000; connect() } }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        goForeground("Starting…")
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(netCallback)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground(notifText())
        if (!prefs.enabled || !prefs.configured) { stopSelf(); return START_NOT_STICKY }
        if (intent?.action == ACTION_RECONNECT || socket == null) { backoffMs = 1_000; connect() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        main.removeCallbacksAndMessages(null)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(netCallback) }
        socket?.close(1000, "bye"); socket = null
        Status.set(Status.Conn.OFF)
        super.onDestroy()
    }

    // ------------------------------------------------------------- websocket

    private fun connect() {
        if (stopped) return
        main.removeCallbacksAndMessages(null)
        socket?.cancel()
        val gen = ++generation
        Status.set(Status.Conn.CONNECTING, prefs.serverUrl); refreshNotif()

        val req = try {
            Request.Builder()
                .url(prefs.serverUrl + "/api/v1/ws")       // OkHttp maps http(s) -> ws(s)
                .header("Authorization", "Bearer " + prefs.token)
                .build()
        } catch (e: IllegalArgumentException) {
            Status.set(Status.Conn.ERROR, "Invalid server URL"); refreshNotif(); return
        }

        socket = SyncApi.http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                main.post {
                    if (gen != generation) return@post
                    backoffMs = 1_000
                    Status.set(Status.Conn.LIVE, prefs.serverUrl); refreshNotif()
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                if (gen != generation) return
                val snap = SyncApi.parse(text) ?: return
                SyncApi.worker.execute {
                    try {
                        SyncApi.apply(this@GuardService, snap)
                    } catch (e: Exception) {
                        Log.e(TAG, "apply failed", e); Status.result("Contact update failed: ${e.message}")
                    }
                    main.post { refreshNotif() }
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(1000, null) }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                main.post { if (gen == generation) retry(if (code == 4401) "Device token rejected" else "Disconnected") }
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                val why = if (response?.code == 401 || response?.code == 403) "Device token rejected"
                          else (t.message ?: t.javaClass.simpleName)
                main.post { if (gen == generation) retry(why) }
            }
        })
    }

    private fun retry(why: String) {
        if (stopped) return
        Log.i(TAG, "socket down ($why), retry in ${backoffMs}ms")
        Status.set(Status.Conn.ERROR, "$why – retrying in ${backoffMs / 1000}s"); refreshNotif()
        main.postDelayed({ connect() }, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(60_000)
    }

    // ----------------------------------------------------------- notification

    private fun notifText(): String {
        val n = prefs.lastCount
        return when (Status.conn) {
            Status.Conn.LIVE -> "Live · $n scam number${if (n == 1) "" else "s"} tagged in contacts"
            Status.Conn.CONNECTING -> "Connecting… · $n numbers"
            Status.Conn.ERROR -> "Offline – ${Status.detail}"
            Status.Conn.OFF -> "Starting…"
        }
    }

    private fun build(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_shield)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .build()
    }

    private fun goForeground(text: String) {
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIF_ID, build(text), type)
    }

    private fun refreshNotif() {
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, build(notifText()))
    }
}
