package app.mirsad.shield.demo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import app.mirsad.shield.MainActivity

/**
 * Debug-only storyboard driver, so the demo video is reproducible without screen coordinates:
 *
 *   adb shell am broadcast -a app.mirsad.shield.AUTOPILOT -n app.mirsad.shield/.demo.AutopilotReceiver --es step <name>
 *
 * Steps: home, demo, demo_scam, incident, restore, call, report, quarantine, settings, onboarding, lang_ar, lang_en.
 * The step is posted to [AutopilotBus]; the root composable consumes it. If the activity is not running it is started
 * first and the pending step is picked up as soon as the root subscribes.
 */
class AutopilotReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val step = intent.getStringExtra("step")?.trim()?.lowercase()
        if (step.isNullOrEmpty() || step !in AutopilotBus.STEPS) {
            Log.w(TAG, "usage: --es step <${AutopilotBus.STEPS.joinToString("|")}> (got '$step')")
            return
        }
        Log.i(TAG, "step=$step listener=${AutopilotBus.hasListener}")
        AutopilotBus.post(step)
        if (!AutopilotBus.hasListener) {
            // Android 10+ usually blocks this start from the background (BAL_BLOCK); the persisted step is then
            // consumed by MainActivity when the storyboard runs `adb shell am start -n app.mirsad.shield/.MainActivity`.
            AutopilotBus.persist(context, step)
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    private companion object {
        const val TAG = "MirsadAutopilot"
    }
}
