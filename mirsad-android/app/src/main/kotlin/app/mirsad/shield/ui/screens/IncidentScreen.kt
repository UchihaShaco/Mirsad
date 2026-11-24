package app.mirsad.shield.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.IncidentFilter
import app.mirsad.core.contract.Level
import app.mirsad.core.contract.Reason
import app.mirsad.shield.AppContainer
import app.mirsad.shield.BuildConfig
import app.mirsad.shield.R
import app.mirsad.shield.ui.Routes
import app.mirsad.shield.ui.bidiSafe
import app.mirsad.shield.ui.contentStyle
import app.mirsad.shield.ui.ltrIsolate
import app.mirsad.shield.ui.appLabel
import app.mirsad.shield.ui.artifactTypeRes
import app.mirsad.shield.ui.channelLabel
import app.mirsad.shield.ui.components.LevelBadge
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.components.SafetyLine
import app.mirsad.shield.ui.components.SectionTitle
import app.mirsad.shield.ui.components.TagPill
import app.mirsad.shield.ui.components.WeightBar
import app.mirsad.shield.ui.levelHeadline
import app.mirsad.shield.ui.reasonText
import app.mirsad.shield.ui.relativeTime
import app.mirsad.shield.ui.sourceLabel
import app.mirsad.shield.ui.theme.levelColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

@Composable
fun IncidentScreen(
    container: AppContainer,
    incidentId: Long,
    action: String?,
    onBack: () -> Unit,
    onReport: (Long) -> Unit,
) {
    val all by remember { container.incidents.observe(IncidentFilter(includeAllowed = true)) }
        .collectAsStateWithLifecycle(initialValue = null)
    val incident = all?.firstOrNull { it.id == incidentId }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val restoredMessage = stringResource(R.string.restored_snackbar)
    val undoLabel = stringResource(R.string.action_undo)
    var working by remember { mutableStateOf(false) }

    val notScam: () -> Unit = {
        if (!working) {
            working = true
            scope.launch {
                try {
                    val token = withContext(Dispatchers.Default) { container.pipeline.markNotScam(incidentId) }
                    val result = snackbar.showSnackbar(restoredMessage, actionLabel = undoLabel, duration = SnackbarDuration.Long)
                    if (result == SnackbarResult.ActionPerformed) {
                        withContext(Dispatchers.Default) { container.pipeline.undoNotScam(token) }
                    }
                } finally {
                    working = false
                }
            }
        }
    }

    // Autopilot "restore": perform Not a scam once on arrival.
    var autoDone by rememberSaveable(incidentId) { mutableStateOf(false) }
    LaunchedEffect(incident?.id, action) {
        if (incident != null && action == Routes.ACTION_RESTORE && !autoDone) {
            autoDone = true
            // Let the held state stay on screen for a moment before the automatic tap (demo recording).
            kotlinx.coroutines.delay(2200)
            notScam()
        }
    }

    Scaffold(
        topBar = { MirsadTopBar(stringResource(R.string.incident_title), onBack = onBack) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        when {
            all == null -> Box(Modifier.fillMaxSize().padding(padding))
            incident == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.incident_not_found), style = MaterialTheme.typography.bodyLarge)
            }
            else -> IncidentBody(
                incident = incident,
                modifier = Modifier.padding(padding),
                working = working,
                onNotScam = notScam,
                onReport = { onReport(incident.id) },
            )
        }
    }
}

@Composable
private fun IncidentBody(
    incident: Incident,
    modifier: Modifier,
    working: Boolean,
    onNotScam: () -> Unit,
    onReport: () -> Unit,
) {
    val context = LocalContext.current
    val colours = levelColors(incident.level)
    val restored = incident.feedback == FeedbackVerdict.FALSE_POSITIVE
    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Verdict header
        Card(
            colors = CardDefaults.cardColors(containerColor = colours.container, contentColor = colours.onContainer),
            shape = MaterialTheme.shapes.large,
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LevelBadge(incident.level, large = true)
                    if (incident.synthetic) TagPill(stringResource(R.string.synthetic_badge))
                    if (restored) TagPill(stringResource(R.string.restored_tag))
                    if (incident.feedback == FeedbackVerdict.CONFIRMED_SCAM) TagPill(stringResource(R.string.confirmed_scam_tag))
                }
                Text(levelHeadline(incident.level), style = MaterialTheme.typography.headlineSmall, color = colours.onContainer)
                Text(
                    stringResource(R.string.incident_score, (incident.score * 100).roundToInt()) + " · " +
                        channelLabel(incident.channel) + " · " + sourceLabel(incident.source) + " · " + relativeTime(incident.createdAt),
                    style = MaterialTheme.typography.bodyMedium, color = colours.onContainer,
                )
                if (restored) {
                    Text(stringResource(R.string.already_restored), style = MaterialTheme.typography.bodyMedium, color = colours.onContainer, fontWeight = FontWeight.Medium)
                }
            }
        }

        SafetyLine()

        // The message or the call card
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val senderShown = bidiSafe(incident.sender.ifBlank { stringResource(R.string.unknown_sender) })
                if (incident.channel == Channel.CALL) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.ic_call), null, Modifier.size(22.dp), tint = colours.accent)
                        Spacer(Modifier.width(10.dp))
                        Text(stringResource(R.string.incident_call_card, senderShown), style = MaterialTheme.typography.titleMedium)
                    }
                    Text(
                        stringResource(
                            when (incident.level) {
                                Level.HOLD -> R.string.incident_call_rejected
                                Level.WARN -> R.string.incident_call_warned
                                Level.ALLOW -> R.string.incident_call_allowed
                            },
                        ),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    val app = appLabel(context, incident.appPackage)
                    Text(
                        stringResource(R.string.incident_from, incident.title?.takeIf { it.isNotBlank() && it != incident.sender }?.let { "$it ($senderShown)" } ?: senderShown) +
                            (app?.let { " · " + stringResource(R.string.incident_via, it) } ?: ""),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    SelectionContainer {
                        Text(incident.text?.ifBlank { null } ?: stringResource(R.string.row_no_text), style = contentStyle(MaterialTheme.typography.bodyLarge, incident.text))
                    }
                    if (incident.notificationRemoved) {
                        Text(stringResource(R.string.incident_notification_removed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // Reasons
        SectionTitle(stringResource(R.string.incident_why))
        val reasons = app.mirsad.core.contract.ReasonOrder.forDisplay(incident.reasons)
        if (reasons.isEmpty()) {
            Text(stringResource(R.string.incident_no_reasons), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(16.dp)) {
                    reasons.forEachIndexed { i, r ->
                        ReasonRow(r, incident.level)
                        if (i < reasons.lastIndex) HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }

        // Artifacts grouped by type
        if (incident.artifacts.isNotEmpty()) {
            SectionTitle(stringResource(R.string.incident_artifacts))
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    incident.artifacts.groupBy { it.type }.forEach { (type, items) ->
                        Column {
                            Text(stringResource(artifactTypeRes(type)), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            items.distinctBy { it.value }.forEach { a ->
                                SelectionContainer { Text(ltrIsolate(a.value), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium) }
                            }
                        }
                    }
                }
            }
        }

        // Footer: latency + versions
        Column {
            Text(if (incident.latencyMs <= 0) stringResource(R.string.incident_analysed_sub_ms) else stringResource(R.string.incident_analysed, incident.latencyMs), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.incident_versions, incident.modelVersion, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        // Actions
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!restored) {
                OutlinedButton(onClick = onNotScam, enabled = !working, modifier = Modifier.weight(1f)) {
                    Icon(painterResource(R.drawable.ic_restore), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.not_a_scam))
                }
            }
            Button(onClick = onReport, modifier = Modifier.weight(1f)) {
                Icon(painterResource(R.drawable.ic_share), null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.report))
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun ReasonRow(reason: Reason, level: Level) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(reasonText(reason), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Text(
                ltrIsolate((if (reason.weight > 0) "+" else "") + String.format(java.util.Locale.US, "%.2f", reason.weight)),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(6.dp))
        WeightBar(reason.weight, level)
        val tags = buildList {
            if (reason.hard) add(stringResource(R.string.incident_hard))
            if (reason.weight < 0) add(stringResource(R.string.incident_safe_signal))
            app.mirsad.core.contract.ReasonDetail.display(reason)?.let { add(ltrIsolate(it)) }
        }
        if (tags.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tags.forEach { t ->
                    val c = levelColors(if (reason.weight < 0) Level.ALLOW else if (level == Level.ALLOW) Level.WARN else level)
                    Box(Modifier.clip(RoundedCornerShape(50)).background(c.container)) {
                        Text(t, Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, color = c.onContainer)
                    }
                }
            }
        }
    }
}
