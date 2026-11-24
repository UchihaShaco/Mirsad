package app.mirsad.shield.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.IncidentFilter
import app.mirsad.core.contract.Level
import app.mirsad.shield.AppContainer
import app.mirsad.shield.R
import app.mirsad.shield.ui.components.IncidentRow
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.components.SafetyLine

@Composable
fun QuarantineScreen(container: AppContainer, onOpenIncident: (Long) -> Unit) {
    var channel by rememberSaveable { mutableStateOf<Channel?>(null) }
    var level by rememberSaveable { mutableStateOf<Level?>(null) }
    var includeAllowed by rememberSaveable { mutableStateOf(false) }
    val filter = IncidentFilter(channel = channel, level = level, includeAllowed = includeAllowed)
    val items by remember(filter) { container.incidents.observe(filter) }.collectAsStateWithLifecycle(initialValue = emptyList())

    Scaffold(topBar = { MirsadTopBar(stringResource(R.string.quarantine_title)) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Card(
                Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
                shape = MaterialTheme.shapes.medium,
            ) {
                Text(
                    stringResource(R.string.quarantine_banner), Modifier.padding(14.dp),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(selected = channel == null, onClick = { channel = null }, label = { Text(stringResource(R.string.filter_all)) })
                FilterChip(selected = channel == Channel.CALL, onClick = { channel = Channel.CALL }, label = { Text(stringResource(R.string.filter_calls)) })
                FilterChip(selected = channel == Channel.SMS, onClick = { channel = Channel.SMS }, label = { Text(stringResource(R.string.filter_sms)) })
                FilterChip(selected = channel == Channel.CHAT, onClick = { channel = Channel.CHAT }, label = { Text(stringResource(R.string.filter_chat)) })
            }
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(selected = level == Level.HOLD, onClick = { level = if (level == Level.HOLD) null else Level.HOLD }, label = { Text(stringResource(R.string.filter_held)) })
                FilterChip(selected = level == Level.WARN, onClick = { level = if (level == Level.WARN) null else Level.WARN }, label = { Text(stringResource(R.string.filter_warned)) })
                FilterChip(selected = includeAllowed, onClick = { includeAllowed = !includeAllowed }, label = { Text(stringResource(R.string.filter_show_allowed)) })
            }
            if (items.isEmpty()) {
                Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(
                        stringResource(R.string.quarantine_empty), style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                    )
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    item { SafetyLine() }
                    items(items, key = { it.id }) { inc -> IncidentRow(inc, onClick = { onOpenIncident(inc.id) }) }
                }
            }
        }
    }
}
