package app.mirsad.shield.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.Sensitivity
import app.mirsad.core.contract.Settings
import app.mirsad.core.contract.SettingsStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow

/** Settings in SharedPreferences, mirrored in a StateFlow so the UI can observe them. */
class PrefsSettingsStore(context: Context) : SettingsStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val state = MutableStateFlow(read())
    private val lock = Any()

    override fun observe(): Flow<Settings> = state

    override suspend fun get(): Settings = state.value

    override suspend fun update(transform: (Settings) -> Settings) {
        synchronized(lock) {
            val next = transform(state.value)
            write(next)
            state.value = next
        }
    }

    private fun read(): Settings = Settings(
        language = prefs.getString(KEY_LANGUAGE, null)?.takeIf { it.isNotBlank() } ?: "system",
        sensitivity = prefs.getString(KEY_SENSITIVITY, null)
            ?.let { name -> Sensitivity.entries.firstOrNull { it.name == name } }
            ?: Sensitivity.BALANCED,
        monitoredPackages = prefs.getStringSet(KEY_PACKAGES, null)?.toSet() ?: DefaultPackages.ALL,
        onboardingDone = prefs.getBoolean(KEY_ONBOARDING, false),
    )

    private fun write(settings: Settings) {
        prefs.edit {
            putString(KEY_LANGUAGE, settings.language)
            putString(KEY_SENSITIVITY, settings.sensitivity.name)
            putStringSet(KEY_PACKAGES, HashSet(settings.monitoredPackages))
            putBoolean(KEY_ONBOARDING, settings.onboardingDone)
        }
    }

    private companion object {
        const val PREFS_NAME = "mirsad_settings"
        const val KEY_LANGUAGE = "language"
        const val KEY_SENSITIVITY = "sensitivity"
        const val KEY_PACKAGES = "monitored_packages"
        const val KEY_ONBOARDING = "onboarding_done"
    }
}
