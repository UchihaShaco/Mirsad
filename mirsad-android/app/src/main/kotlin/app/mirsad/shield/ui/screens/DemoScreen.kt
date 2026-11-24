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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.IncidentSource
import app.mirsad.core.contract.Level
import app.mirsad.shield.R
import app.mirsad.shield.demo.DemoSample
import app.mirsad.shield.demo.DemoSeeds
import app.mirsad.shield.ui.bidiSafe
import app.mirsad.shield.ui.channelIcon
import app.mirsad.shield.ui.contentStyle
import app.mirsad.shield.ui.channelLabel
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.components.SectionTitle
import app.mirsad.shield.ui.components.TagPill
import app.mirsad.shield.ui.theme.levelColors

/**
 * Judges see this first. Every tap runs the real pipeline (IncidentSource.DEMO, synthetic = true) through
 * [onRun], which the root implements and which then opens the Incident screen.
 */
@Composable
fun DemoScreen(
    prefillText: String?,
    busy: Boolean,
    onRun: (Event, IncidentSource, Boolean) -> Unit,
) {
    var sender by rememberSaveable { mutableStateOf("") }
    var text by rememberSaveable(prefillText) { mutableStateOf(prefillText ?: "") }
    var callNumber by rememberSaveable { mutableStateOf(DemoSeeds.DEMO_CALL_NUMBER) }

    Scaffold(topBar = { MirsadTopBar(stringResource(R.string.demo_title)) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Text(stringResource(R.string.demo_intro), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (prefillText != null) {
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                            Text(
                                stringResource(R.string.demo_shared_banner),
                                Modifier.padding(14.dp), style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                        }
                    }
                }
                item { SectionTitle(stringResource(R.string.demo_scam_samples)) }
                items(DemoSeeds.scams) { sample ->
                    SampleCard(sample, enabled = !busy) { onRun(sample.toEvent(), IncidentSource.DEMO, true) }
                }
                item { SectionTitle(stringResource(R.string.demo_legit_samples)) }
                items(DemoSeeds.legit) { sample ->
                    SampleCard(sample, enabled = !busy) { onRun(sample.toEvent(), IncidentSource.DEMO, true) }
                }
                item { SectionTitle(stringResource(R.string.demo_wrong_samples)) }
                item {
                    Text(
                        stringResource(R.string.demo_wrong_note),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(DemoSeeds.wronglyHeld) { sample ->
                    SampleCard(sample, enabled = !busy) { onRun(sample.toEvent(), IncidentSource.DEMO, true) }
                }
                item { SectionTitle(stringResource(R.string.demo_paste_title)) }
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            OutlinedTextField(
                                value = sender, onValueChange = { sender = it },
                                label = { Text(stringResource(R.string.demo_sender_label)) },
                                singleLine = true, modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedTextField(
                                value = text, onValueChange = { text = it },
                                label = { Text(stringResource(R.string.demo_text_label)) },
                                minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth(),
                            )
                            Button(
                                onClick = {
                                    val now = System.currentTimeMillis()
                                    onRun(Event(Channel.SMS, sender.trim(), text.trim(), null, now, false), IncidentSource.DEMO, true)
                                },
                                enabled = !busy && text.isNotBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(painterResource(R.drawable.ic_send), null, Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.demo_analyse))
                            }
                        }
                    }
                }
                item { SectionTitle(stringResource(R.string.demo_call_title)) }
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            OutlinedTextField(
                                value = callNumber, onValueChange = { callNumber = it },
                                label = { Text(stringResource(R.string.demo_call_number)) },
                                singleLine = true, modifier = Modifier.fillMaxWidth(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            )
                            OutlinedButton(
                                onClick = { onRun(DemoSeeds.callEvent(callNumber.trim()), IncidentSource.DEMO, true) },
                                enabled = !busy && callNumber.isNotBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(painterResource(R.drawable.ic_call), null, Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.demo_call_button))
                            }
                        }
                    }
                }
                item {
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.ic_info), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.demo_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (busy) {
                Column(Modifier.fillMaxWidth().align(Alignment.TopCenter)) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Row(
                        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(10.dp))
                        Text(stringResource(R.string.demo_running), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun SampleCard(sample: DemoSample, enabled: Boolean, onClick: () -> Unit) {
    val tint = levelColors(if (sample.scam) Level.HOLD else Level.ALLOW)
    Card(
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(tint.container),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(channelIcon(sample.channel)), contentDescription = channelLabel(sample.channel), tint = tint.accent, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(bidiSafe(sample.sender), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    TagPill(channelLabel(sample.channel))
                    if (sample.contact) TagPill(stringResource(R.string.demo_contact_tag))
                }
                Spacer(Modifier.height(4.dp))
                Text(sample.text, style = contentStyle(MaterialTheme.typography.bodyMedium, sample.text), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
