package app.mirsad.shield.share

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import app.mirsad.shield.MainActivity

/** Stub. Workstream D: runs the shared text through the pipeline and opens the incident screen. */
class ShareReceiverActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent?.getStringExtra(Intent.EXTRA_TEXT)
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_SCREEN, "demo")
            putExtra(Intent.EXTRA_TEXT, text)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        finish()
    }
}
