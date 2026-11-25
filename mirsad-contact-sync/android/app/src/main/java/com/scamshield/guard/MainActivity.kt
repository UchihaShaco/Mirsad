package com.scamshield.guard

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var statusTitle: TextView
    private lateinit var statusDetail: TextView
    private lateinit var lastResult: TextView
    private lateinit var toggle: Button
    private lateinit var battery: Button
    private lateinit var serverUrl: EditText
    private lateinit var token: EditText

    private val render: () -> Unit = { renderStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        actionBar?.hide()   // the layout has its own big title
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        statusTitle = findViewById(R.id.statusTitle)
        statusDetail = findViewById(R.id.statusDetail)
        lastResult = findViewById(R.id.lastResult)
        toggle = findViewById(R.id.toggle)
        battery = findViewById(R.id.battery)
        serverUrl = findViewById(R.id.serverUrl)
        token = findViewById(R.id.token)

        serverUrl.setText(prefs.serverUrl)
        token.setText(prefs.token)

        toggle.setOnClickListener { if (prefs.enabled) turnOff(false) else turnOn() }
        findViewById<Button>(R.id.syncNow).setOnClickListener { syncNow() }
        findViewById<Button>(R.id.openContact).setOnClickListener { openContact() }
        findViewById<Button>(R.id.removeAll).setOnClickListener { turnOff(true) }
        battery.setOnClickListener { askBatteryExemption() }
    }

    override fun onStart() {
        super.onStart()
        Status.listen(render)
        renderStatus()
        // Make sure the service is up whenever the user opens the app.
        if (prefs.enabled && prefs.configured && SyncApi.hasContactsPermission(this) && Status.conn == Status.Conn.OFF) {
            GuardService.start(this)
        }
    }

    // The battery-exemption prompt is a dialog (we only get paused), so re-render on resume too.
    override fun onResume() {
        super.onResume()
        renderStatus()
    }

    override fun onStop() {
        Status.unlisten(render)
        super.onStop()
    }

    // ------------------------------------------------------------------ actions

    private fun saveFields(): Boolean {
        var url = serverUrl.text.toString().trim()
        if (url.isNotEmpty() && !url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
        prefs.serverUrl = url
        prefs.token = token.text.toString()
        serverUrl.setText(prefs.serverUrl)
        if (!prefs.configured) { toast("Enter the server URL and device token first"); return false }
        return true
    }

    private fun turnOn() {
        if (!saveFields()) return
        val needed = mutableListOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
        if (Build.VERSION.SDK_INT >= 33) needed += Manifest.permission.POST_NOTIFICATIONS
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1) else startProtection()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (SyncApi.hasContactsPermission(this)) startProtection()
        else toast("Mirsad needs Contacts access to create the warning contact")
    }

    private fun startProtection() {
        prefs.enabled = true
        GuardService.reconnect(this)
        FallbackWorker.schedule(this)
        renderStatus()
        if (!isBatteryExempt()) askBatteryExemption()
    }

    private fun turnOff(removeContacts: Boolean) {
        prefs.enabled = false
        GuardService.stop(this)
        FallbackWorker.cancel(this)
        if (removeContacts && SyncApi.hasContactsPermission(this)) {
            SyncApi.worker.execute {
                val n = ScamContacts.removeAll(this)
                prefs.lastCount = 0
                Status.result("Removed $n scam contact(s)")
            }
        }
        renderStatus()
    }

    private fun syncNow() {
        if (!saveFields()) return
        if (!SyncApi.hasContactsPermission(this)) { turnOn(); return }
        Status.result("Syncing…")
        SyncApi.worker.execute {
            try {
                SyncApi.apply(this, SyncApi.fetch(prefs))
            } catch (e: Exception) {
                Status.result("Sync failed: ${e.message}")
            }
        }
        if (prefs.enabled) GuardService.reconnect(this)
    }

    private fun openContact() {
        if (!SyncApi.hasContactsPermission(this)) { toast("Grant Contacts access first"); return }
        SyncApi.worker.execute {
            val uri = ScamContacts.firstContactUri(this)
            runOnUiThread {
                if (uri == null) toast("No scam contact yet – flag a number on the dashboard")
                else startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
        }
    }

    private fun isBatteryExempt() =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    @SuppressLint("BatteryLife") // sideloaded protection app: exemption is the whole point
    private fun askBatteryExemption() {
        if (isBatteryExempt()) {
            // Samsung also has its own "Sleeping apps" list; send the user to app details to set Battery → Unrestricted.
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            return
        }
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }

    // ------------------------------------------------------------------- render

    private fun renderStatus() {
        val on = prefs.enabled
        toggle.text = if (on) "Turn off protection" else "Turn on protection"
        statusTitle.text = when {
            !on -> "Protection off"
            Status.conn == Status.Conn.LIVE -> "Protected · live"
            Status.conn == Status.Conn.CONNECTING -> "Connecting…"
            Status.conn == Status.Conn.ERROR -> "Offline – will retry"
            else -> "Starting…"
        }
        statusDetail.text = if (on) Status.detail else "Turn on to keep the scam contact updated automatically."
        lastResult.text = Status.lastResult.ifBlank {
            if (prefs.lastSyncAt > 0) "${prefs.lastCount} numbers in contacts" else "Not synced yet"
        }
        battery.visibility = if (isBatteryExempt()) View.GONE else View.VISIBLE
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
