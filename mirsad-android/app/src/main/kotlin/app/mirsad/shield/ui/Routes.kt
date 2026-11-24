package app.mirsad.shield.ui

/** Navigation routes. The four top-level ones carry the bottom bar. */
object Routes {
    const val ONBOARDING = "onboarding"
    const val HOME = "home"
    const val DEMO = "demo"
    const val QUARANTINE = "quarantine"
    const val SETTINGS = "settings"
    const val INCIDENT = "incident/{id}?action={action}"
    const val REPORT = "report/{id}"

    /** Autopilot "restore" asks the Incident screen to tap Not a scam on arrival. */
    const val ACTION_RESTORE = "restore"

    val topLevel = listOf(HOME, DEMO, QUARANTINE, SETTINGS)

    fun incident(id: Long, action: String? = null): String =
        if (action == null) "incident/$id" else "incident/$id?action=$action"

    fun report(id: Long): String = "report/$id"

    /** Maps the MainActivity EXTRA_SCREEN values to routes; unknown values go Home. */
    fun fromScreenName(name: String?): String = when (name) {
        "quarantine" -> QUARANTINE
        "demo" -> DEMO
        "settings" -> SETTINGS
        "onboarding" -> ONBOARDING
        else -> HOME
    }
}
