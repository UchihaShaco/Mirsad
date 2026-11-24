package app.mirsad.shield

import android.app.Application
import app.mirsad.shield.bootstrap.InMemoryContainer

/** Owned by workstream D: swap InMemoryContainer for the Room-backed container here. */
class MirsadApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = InMemoryContainer(this)
    }

    companion object {
        fun container(context: android.content.Context): AppContainer =
            (context.applicationContext as MirsadApp).container
    }
}
