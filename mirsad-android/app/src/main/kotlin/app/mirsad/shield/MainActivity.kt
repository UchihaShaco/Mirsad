package app.mirsad.shield

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import app.mirsad.shield.demo.AutopilotBus
import app.mirsad.shield.ui.MirsadRoot
import app.mirsad.shield.ui.NavBus
import app.mirsad.shield.ui.NavRequest

/**
 * Single-activity app (AppCompatActivity so the in-app language switch persists through AppCompat). Deep links:
 *   EXTRA_INCIDENT_ID (Long)  -> open the incident screen
 *   EXTRA_SCREEN (String)     -> "home" | "quarantine" | "demo" | "settings" | "onboarding" | "report"
 *   Intent.EXTRA_TEXT         -> "Check a message": open Demo prefilled and analyse it (source SHARE)
 * The initial extras go to MirsadRoot; shared text and later intents (singleTop) go through NavBus.
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val launchIntent = intent
        setContent {
            MirsadRoot(
                container = MirsadApp.container(this),
                initialIncidentId = launchIntent?.getLongExtra(EXTRA_INCIDENT_ID, -1L)?.takeIf { it > 0 },
                initialScreen = launchIntent?.getStringExtra(EXTRA_SCREEN),
            )
        }
        // Only on a fresh start: a recreation (rotation, language switch) must not re-analyse the shared text.
        if (savedInstanceState == null) {
            launchIntent?.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }?.let { text ->
                NavBus.post(NavRequest(sharedText = text))
            }
            // Debug autopilot step broadcast while the app was not running (nothing writes this in release).
            AutopilotBus.takePersisted(this)?.let { AutopilotBus.post(it) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val request = NavRequest(
            incidentId = intent.getLongExtra(EXTRA_INCIDENT_ID, -1L).takeIf { it > 0 },
            screen = intent.getStringExtra(EXTRA_SCREEN),
            sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() },
        )
        if (request.incidentId != null || request.screen != null || request.sharedText != null) NavBus.post(request)
    }

    companion object {
        const val EXTRA_INCIDENT_ID = "app.mirsad.shield.extra.INCIDENT_ID"
        const val EXTRA_SCREEN = "app.mirsad.shield.extra.SCREEN"
    }
}
