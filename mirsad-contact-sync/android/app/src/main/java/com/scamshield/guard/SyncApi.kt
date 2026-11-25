package com.scamshield.guard

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.dnsoverhttps.DnsOverHttps
import org.json.JSONObject
import java.net.InetAddress
import java.net.UnknownHostException
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Talks to the sync server and applies snapshots to contacts. */
object SyncApi {
    private const val TAG = "SyncApi"

    /**
     * System DNS first; if that can't resolve the server (captive/odd venue Wi-Fi, stale negative
     * cache right after creating the tunnel hostname) fall back to DNS-over-HTTPS via Cloudflare/Google.
     */
    private val fallbackDns: Dns by lazy {
        val bootstrap = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).build()
        fun doh(url: String, vararg ips: String) = DnsOverHttps.Builder().client(bootstrap)
            .url(url.toHttpUrl())
            .bootstrapDnsHosts(ips.map { InetAddress.getByName(it) })
            .includeIPv6(false)
            .build()
        val providers = listOf(
            doh("https://cloudflare-dns.com/dns-query", "1.1.1.1", "1.0.0.1"),
            doh("https://dns.google/dns-query", "8.8.8.8", "8.8.4.4"),
        )
        object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                try {
                    return Dns.SYSTEM.lookup(hostname)
                } catch (e: UnknownHostException) {
                    for (p in providers) {
                        try {
                            return p.lookup(hostname).also { Log.i(TAG, "resolved $hostname via DoH") }
                        } catch (_: Exception) { }
                    }
                    throw e
                }
            }
        }
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .dns(fallbackDns)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)          // WebSocket: no read timeout…
        .pingInterval(25, TimeUnit.SECONDS)        // …but keep NATs / Cloudflare (100s idle) alive
        .retryOnConnectionFailure(true)
        .build()

    /** All contact writes happen on this one thread, in order. */
    val worker = Executors.newSingleThreadExecutor { Thread(it, "scamshield-sync") }

    data class Snapshot(val version: Long, val name: String, val numbers: List<String>)

    fun parse(json: String): Snapshot? = try {
        val o = JSONObject(json)
        if (o.optString("type", "snapshot") != "snapshot") null else {
            val arr = o.getJSONArray("numbers")
            Snapshot(
                o.optLong("version", -1),
                o.optString("contact_name").ifBlank { ScamContacts.DEFAULT_NAME },
                List(arr.length()) { arr.getString(it) }
            )
        }
    } catch (e: Exception) {
        Log.w(TAG, "bad message: $json", e); null
    }

    /** Blocking REST fetch (used by the fallback worker and "Sync now"). */
    fun fetch(prefs: Prefs): Snapshot {
        val req = Request.Builder()
            .url(prefs.serverUrl + "/api/v1/snapshot")
            .header("Authorization", "Bearer " + prefs.token)
            .build()
        http.newCall(req).execute().use { r ->
            if (r.code == 401) throw IllegalStateException("Server rejected the device token")
            if (!r.isSuccessful) throw IllegalStateException("Server error ${r.code}")
            return parse(r.body!!.string()) ?: throw IllegalStateException("Unexpected response")
        }
    }

    fun hasContactsPermission(ctx: Context) =
        ctx.checkSelfPermission(Manifest.permission.WRITE_CONTACTS) == PackageManager.PERMISSION_GRANTED &&
            ctx.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    /** Apply a snapshot to the address book. Call from [worker]. Returns a human summary. */
    fun apply(ctx: Context, snap: Snapshot): String {
        val prefs = Prefs(ctx)
        if (!hasContactsPermission(ctx)) {
            val msg = "Contacts permission missing – open the app to grant it"
            Status.result(msg); return msg
        }
        val r = ScamContacts.sync(ctx, snap.numbers, snap.name)
        prefs.lastVersion = snap.version
        prefs.lastCount = r.total
        prefs.lastSyncAt = System.currentTimeMillis()
        val time = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(prefs.lastSyncAt))
        val change = if (r.added == 0 && r.removed == 0) "up to date" else "+${r.added} / −${r.removed}"
        val msg = "${r.total} numbers in ${r.contacts} contact(s) · $change · $time"
        Status.result(msg)
        return msg
    }
}
