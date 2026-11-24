package app.mirsad.shield

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.mirsad.shield.ui.MirsadRoot

/**
 * Single-activity app. Workstream C owns ui/ and MirsadRoot. Deep links:
 *   EXTRA_INCIDENT_ID (Long)  -> open the incident screen
 *   EXTRA_SCREEN (String)     -> "home" | "quarantine" | "demo" | "settings" | "onboarding" | "report"
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MirsadRoot(
                container = MirsadApp.container(this),
                initialIncidentId = intent?.getLongExtra(EXTRA_INCIDENT_ID, -1L)?.takeIf { it > 0 },
                initialScreen = intent?.getStringExtra(EXTRA_SCREEN),
            )
        }
    }

    companion object {
        const val EXTRA_INCIDENT_ID = "app.mirsad.shield.extra.INCIDENT_ID"
        const val EXTRA_SCREEN = "app.mirsad.shield.extra.SCREEN"
    }
}
