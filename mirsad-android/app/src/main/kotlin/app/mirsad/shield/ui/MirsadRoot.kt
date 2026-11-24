package app.mirsad.shield.ui

import android.widget.Toast
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.IncidentSource
import app.mirsad.shield.AppContainer
import app.mirsad.shield.R
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.IncidentFilter
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.ListKind
import app.mirsad.shield.demo.AutopilotBus
import app.mirsad.shield.demo.DemoSeeds
import app.mirsad.shield.ui.screens.DemoScreen
import app.mirsad.shield.ui.screens.HomeScreen
import app.mirsad.shield.ui.screens.IncidentScreen
import app.mirsad.shield.ui.screens.OnboardingScreen
import app.mirsad.shield.ui.screens.QuarantineScreen
import app.mirsad.shield.ui.screens.ReportScreen
import app.mirsad.shield.ui.screens.SettingsScreen
import app.mirsad.shield.ui.theme.MirsadTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Root of the app: theme, navigation, bottom bar, deep links (initial extras, NavBus) and the debug autopilot.
 * Onboarding is the start destination only when settings.onboardingDone is false and no deep link was given.
 */
@Composable
fun MirsadRoot(container: AppContainer, initialIncidentId: Long?, initialScreen: String?) {
    MirsadTheme {
        val settings by container.settings.observe().collectAsStateWithLifecycle(initialValue = null)
        val loaded = settings
        if (loaded == null) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {}
        } else {
            val start = rememberSaveable {
                if (!loaded.onboardingDone && initialIncidentId == null && initialScreen == null) Routes.ONBOARDING else Routes.HOME
            }
            MirsadNavHost(container, start, initialIncidentId, initialScreen)
        }
    }
}

/** Navigation and side effects shared by the screens and the autopilot. */
private class RootActions(
    val nav: NavHostController,
    val container: AppContainer,
    val scope: CoroutineScope,
    val toast: (String) -> Unit,
) {
    var busy by mutableStateOf(false)
    var demoPrefill by mutableStateOf<String?>(null)

    fun goTop(route: String) {
        nav.navigate(route) {
            popUpTo(Routes.HOME) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    /** Clears everything and shows [route]; used when Home must be the only entry (after onboarding, autopilot). */
    fun goFresh(route: String) {
        nav.navigate(route) {
            popUpTo(nav.graph.id) { inclusive = true }
            launchSingleTop = true
        }
    }

    fun openIncident(id: Long, action: String? = null) = nav.navigate(Routes.incident(id, action))
    fun openReport(id: Long) = nav.navigate(Routes.report(id))

    /** Runs the real pipeline off the main thread and opens the resulting incident. */
    fun run(event: Event, source: IncidentSource, synthetic: Boolean, action: String? = null) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val incident = withContext(Dispatchers.Default) { container.pipeline.process(event, source, synthetic) }
                openIncident(incident.id, action)
            } catch (t: Throwable) {
                toast(t.message ?: t::class.java.simpleName)
            } finally {
                busy = false
            }
        }
    }

    suspend fun latestIncidentId(): Long? = container.incidents.observeRecent(1).first().firstOrNull()?.id

    fun applyLanguage(tag: String) {
        scope.launch {
            container.settings.update { it.copy(language = tag) }
            val locales = if (tag == "system") LocaleListCompat.getEmptyLocaleList() else LocaleListCompat.forLanguageTags(tag)
            AppCompatDelegate.setApplicationLocales(locales)
        }
    }

    fun finishOnboarding() {
        scope.launch {
            container.settings.update { it.copy(onboardingDone = true) }
            if (!nav.popBackStack()) goFresh(Routes.HOME)
        }
    }

    fun handle(request: NavRequest) {
        val text = request.sharedText?.trim()
        when {
            !text.isNullOrEmpty() -> {
                demoPrefill = text
                goTop(Routes.DEMO)
                run(Event(Channel.CHAT, "", text, null, System.currentTimeMillis(), false), IncidentSource.SHARE, synthetic = false)
            }
            request.incidentId != null && request.screen == "report" -> openReport(request.incidentId)
            request.incidentId != null -> openIncident(request.incidentId)
            request.screen == "report" -> scope.launch { latestIncidentId()?.let { openReport(it) } }
            request.screen == "onboarding" -> nav.navigate(Routes.ONBOARDING)
            request.screen != null -> goTop(Routes.fromScreenName(request.screen))
        }
    }

    fun autopilot(step: String) {
        when (step) {
            "home" -> goFresh(Routes.HOME)
            "demo" -> goTop(Routes.DEMO)
            "demo_scam" -> run(DemoSeeds.PARCEL_FEE.toEvent(), IncidentSource.DEMO, synthetic = true)
            "incident" -> scope.launch { latestIncidentId()?.let { openIncident(it) } }
            "restore" -> scope.launch {
                // Re-runnable: forget what an earlier run of this step taught the app, so the sample is held again.
                val sample = DemoSeeds.FRIEND_NEW_NUMBER
                withContext(Dispatchers.Default) {
                    val fingerprint = container.engine.analyse(sample.toEvent()).fingerprint
                    container.lists.removeValue(ListKind.ALLOW_SENDER, sample.sender)
                    container.lists.removeValue(ListKind.KNOWN_GOOD_FINGERPRINT, fingerprint)
                }
                run(sample.toEvent(), IncidentSource.DEMO, synthetic = true, action = Routes.ACTION_RESTORE)
            }
            "reset" -> scope.launch {
                withContext(Dispatchers.Default) {
                    container.incidents.deleteAll()
                    container.lists.deleteAll()
                    container.feedback.deleteAll()
                }
                goFresh(Routes.HOME)
            }
            "call" -> run(DemoSeeds.callEvent(DemoSeeds.DEMO_CALL_NUMBER), IncidentSource.DEMO, synthetic = true)
            "report" -> scope.launch { latestIncidentId()?.let { openReport(it) } }
            // Report preview for the latest held message (richer than a call: links, domains, fee).
            "report_message" -> scope.launch {
                val held = container.incidents.observe(IncidentFilter(level = Level.HOLD)).first()
                val messages = held.filter { it.channel != Channel.CALL }
                // Prefer a real (non-demo) held message the user has not overruled.
                val pick = messages.firstOrNull { !it.synthetic && it.feedback == FeedbackVerdict.NONE }
                    ?: messages.firstOrNull { it.feedback == FeedbackVerdict.NONE }
                    ?: messages.firstOrNull() ?: held.firstOrNull()
                pick?.let { openReport(it.id) }
            }
            "skip_onboarding" -> scope.launch {
                container.settings.update { it.copy(onboardingDone = true) }
                goFresh(Routes.HOME)
            }
            "quarantine" -> goTop(Routes.QUARANTINE)
            "settings" -> goTop(Routes.SETTINGS)
            "onboarding" -> nav.navigate(Routes.ONBOARDING)
            "lang_ar" -> applyLanguage("ar")
            "lang_en" -> applyLanguage("en")
            else -> toast("autopilot: unknown step '$step'")
        }
    }
}

@Composable
private fun MirsadNavHost(container: AppContainer, startDestination: String, initialIncidentId: Long?, initialScreen: String?) {
    val context = LocalContext.current
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val actions = remember(nav, container) {
        RootActions(nav, container, scope) { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
    }

    // Initial extras: handled once per activity instance (survives recreation through rememberSaveable).
    var initialHandled by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!initialHandled) {
            initialHandled = true
            if (initialIncidentId != null || initialScreen != null) actions.handle(NavRequest(initialIncidentId, initialScreen))
        }
    }
    // Shared text and onNewIntent deep links.
    LaunchedEffect(Unit) {
        NavBus.pending.filterNotNull().collect { req ->
            NavBus.consume(req)
            actions.handle(req)
        }
    }
    // Debug autopilot steps (adb broadcast). No-op in release: nothing posts.
    LaunchedEffect(Unit) {
        AutopilotBus.pending.filterNotNull().collect { step ->
            AutopilotBus.consume(step)
            actions.autopilot(step.name)
        }
    }

    val backStack by nav.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route
    val showBar = currentRoute in Routes.topLevel

    Scaffold(
        bottomBar = {
            if (showBar) {
                NavigationBar {
                    BottomItem(currentRoute, Routes.HOME, R.string.nav_home, R.drawable.ic_home, actions)
                    BottomItem(currentRoute, Routes.DEMO, R.string.nav_demo, R.drawable.ic_play, actions)
                    BottomItem(currentRoute, Routes.QUARANTINE, R.string.nav_quarantine, R.drawable.ic_inbox, actions)
                    BottomItem(currentRoute, Routes.SETTINGS, R.string.nav_settings, R.drawable.ic_settings, actions)
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().let { if (showBar) it.padding(padding) else it }) {
            NavHost(nav, startDestination = startDestination) {
                composable(Routes.ONBOARDING) {
                    OnboardingScreen(
                        onDone = { actions.finishOnboarding() },
                        onBack = if (nav.previousBackStackEntry != null) ({ nav.popBackStack() }) else null,
                    )
                }
                composable(Routes.HOME) {
                    HomeScreen(
                        container = container,
                        onOpenIncident = { actions.openIncident(it) },
                        onDemo = { actions.goTop(Routes.DEMO) },
                        onCheckMessage = { actions.demoPrefill = null; actions.goTop(Routes.DEMO) },
                        onQuarantine = { actions.goTop(Routes.QUARANTINE) },
                        onSetup = { nav.navigate(Routes.ONBOARDING) },
                    )
                }
                composable(Routes.DEMO) {
                    DemoScreen(
                        prefillText = actions.demoPrefill,
                        busy = actions.busy,
                        onRun = { event, source, synthetic -> actions.run(event, source, synthetic) },
                    )
                }
                composable(Routes.QUARANTINE) {
                    QuarantineScreen(container, onOpenIncident = { actions.openIncident(it) })
                }
                composable(Routes.SETTINGS) {
                    SettingsScreen(
                        container = container,
                        onLanguage = { actions.applyLanguage(it) },
                        onOpenOnboarding = { nav.navigate(Routes.ONBOARDING) },
                    )
                }
                composable(
                    Routes.INCIDENT,
                    arguments = listOf(
                        navArgument("id") { type = NavType.LongType },
                        navArgument("action") { type = NavType.StringType; nullable = true; defaultValue = null },
                    ),
                ) { entry ->
                    val id = entry.arguments?.getLong("id") ?: -1L
                    IncidentScreen(
                        container = container,
                        incidentId = id,
                        action = entry.arguments?.getString("action"),
                        onBack = { nav.popBackStack() },
                        onReport = { actions.openReport(it) },
                    )
                }
                composable(Routes.REPORT, arguments = listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                    ReportScreen(container, entry.arguments?.getLong("id") ?: -1L, onBack = { nav.popBackStack() })
                }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.BottomItem(
    current: String?,
    route: String,
    label: Int,
    icon: Int,
    actions: RootActions,
) {
    NavigationBarItem(
        selected = current == route,
        onClick = { actions.goTop(route) },
        icon = { Icon(painterResource(icon), contentDescription = null) },
        label = { Text(stringResource(label)) },
    )
}
