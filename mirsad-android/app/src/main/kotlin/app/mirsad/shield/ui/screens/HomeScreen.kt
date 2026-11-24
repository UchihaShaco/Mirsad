package app.mirsad.shield.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mirsad.core.contract.Level
import app.mirsad.shield.AppContainer
import app.mirsad.shield.R
import app.mirsad.shield.ui.ProtectionStatus
import app.mirsad.shield.ui.components.IncidentRow
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.components.SafetyLine
import app.mirsad.shield.ui.components.SectionTitle
import app.mirsad.shield.ui.startOfToday
import app.mirsad.shield.ui.theme.levelColors

@Composable
fun HomeScreen(
    container: AppContainer,
    onOpenIncident: (Long) -> Unit,
    onDemo: () -> Unit,
    onCheckMessage: () -> Unit,
    onQuarantine: () -> Unit,
    onSetup: () -> Unit,
) {
    val context = LocalContext.current
    var status by remember { mutableStateOf<ProtectionStatus?>(null) }
    LifecycleResumeEffect(Unit) {
        status = ProtectionStatus.read(context)
        onPauseOrDispose { }
    }
    val recent by remember { container.incidents.observeRecent(5) }.collectAsStateWithLifecycle(initialValue = emptyList())
    var today by remember { mutableIntStateOf(0) }
    var total by remember { mutableIntStateOf(0) }
    LaunchedEffect(recent) {
        today = container.incidents.countFlagged(startOfToday())
        total = container.incidents.countFlagged(0)
    }

    Scaffold(topBar = { MirsadTopBar(stringResource(R.string.app_name)) }) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text(stringResource(R.string.app_tagline), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { ProtectionCard(status, onSetup) }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard(stringResource(R.string.home_today), today, Modifier.weight(1f))
                    StatCard(stringResource(R.string.home_total), total, Modifier.weight(1f))
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    QuickAction(stringResource(R.string.quick_demo), R.drawable.ic_play, Modifier.weight(1f), onDemo)
                    QuickAction(stringResource(R.string.quick_check), R.drawable.ic_sms, Modifier.weight(1f), onCheckMessage)
                    QuickAction(stringResource(R.string.quick_quarantine), R.drawable.ic_inbox, Modifier.weight(1f), onQuarantine)
                }
            }
            item { SafetyLine() }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    SectionTitle(stringResource(R.string.home_recent), Modifier.weight(1f))
                    TextButton(onClick = onQuarantine) { Text(stringResource(R.string.action_see_all)) }
                }
            }
            if (recent.isEmpty()) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
                        Text(
                            stringResource(R.string.home_no_incidents), Modifier.fillMaxWidth().padding(20.dp),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                        )
                    }
                }
            } else {
                items(recent, key = { it.id }) { inc -> IncidentRow(inc, onClick = { onOpenIncident(inc.id) }) }
            }
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.home_how_title), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.home_how_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun ProtectionCard(status: ProtectionStatus?, onSetup: () -> Unit) {
    val on = status?.onCount ?: 0
    val colours = levelColors(when (on) { 3 -> Level.ALLOW; 0 -> Level.HOLD; else -> Level.WARN })
    Card(
        colors = CardDefaults.cardColors(containerColor = colours.container, contentColor = colours.onContainer),
        shape = MaterialTheme.shapes.large,
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_shield), null, Modifier.size(28.dp), tint = colours.accent)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.home_protection), style = MaterialTheme.typography.labelLarge, color = colours.onContainer)
                    Text(
                        when (on) {
                            3 -> stringResource(R.string.home_protection_full)
                            0 -> stringResource(R.string.home_protection_none)
                            else -> stringResource(R.string.home_protection_partial, on)
                        },
                        style = MaterialTheme.typography.titleMedium, color = colours.onContainer,
                    )
                }
                if (on < 3) TextButton(onClick = onSetup) { Text(stringResource(R.string.home_setup), color = colours.accent, fontWeight = FontWeight.SemiBold) }
            }
            if (status != null) {
                StatusLine(stringResource(R.string.onb_call_title), status.callScreening, colours.onContainer)
                StatusLine(stringResource(R.string.onb_notif_title), status.notificationAccess, colours.onContainer)
                StatusLine(stringResource(R.string.onb_post_title), status.postNotifications, colours.onContainer)
            }
        }
    }
}

@Composable
private fun StatusLine(label: String, on: Boolean, colour: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(if (on) R.drawable.ic_check_circle else R.drawable.ic_close), null, Modifier.size(18.dp), tint = colour)
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = colour, modifier = Modifier.weight(1f))
        Text(stringResource(if (on) R.string.status_on else R.string.status_off), style = MaterialTheme.typography.labelMedium, color = colour)
    }
}

@Composable
private fun StatCard(label: String, value: Int, modifier: Modifier) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
        Column(Modifier.padding(16.dp)) {
            Text(value.toString(), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun QuickAction(label: String, icon: Int, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.primaryContainer)
            .clickable(onClick = onClick)
            .padding(vertical = 14.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onPrimary)
        }
        Spacer(Modifier.height(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimaryContainer, textAlign = TextAlign.Center, maxLines = 2)
    }
}
