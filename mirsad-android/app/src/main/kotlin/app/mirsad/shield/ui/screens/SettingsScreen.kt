package app.mirsad.shield.ui.screens

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mirsad.core.contract.DefaultPackages
import app.mirsad.core.contract.ListEntry
import app.mirsad.core.contract.ListKind
import app.mirsad.core.contract.Sensitivity
import app.mirsad.core.contract.Settings
import app.mirsad.shield.AppContainer
import app.mirsad.shield.BuildConfig
import app.mirsad.shield.R
import app.mirsad.shield.report.BlocklistImporter
import app.mirsad.shield.ui.appLabel
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.components.SectionTitle
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    container: AppContainer,
    onLanguage: (String) -> Unit,
    onOpenOnboarding: () -> Unit,
) {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val settings by container.settings.observe().collectAsStateWithLifecycle(initialValue = Settings())
    var confirmDelete by remember { mutableStateOf(false) }
    val deletedToast = stringResource(R.string.deleted_toast)
    val importLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            scope.launch {
                val r = BlocklistImporter.import(context, uri)
                val msg = if (r.error != null) resources.getString(R.string.import_failed, r.error)
                else resources.getString(R.string.import_result, r.numbers, r.domains, r.fingerprints)
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            }
        }
    }

    Scaffold(topBar = { MirsadTopBar(stringResource(R.string.settings_title)) }) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Language
            item { SectionTitle(stringResource(R.string.settings_language)) }
            item {
                SettingsCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("system" to R.string.lang_system, "en" to R.string.lang_en, "ar" to R.string.lang_ar).forEach { (tag, label) ->
                            FilterChip(selected = settings.language == tag, onClick = { onLanguage(tag) }, label = { Text(stringResource(label)) })
                        }
                    }
                }
            }

            // Sensitivity
            item { SectionTitle(stringResource(R.string.settings_sensitivity)) }
            item {
                SettingsCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(Sensitivity.RELAXED to R.string.sens_relaxed, Sensitivity.BALANCED to R.string.sens_balanced, Sensitivity.STRICT to R.string.sens_strict).forEach { (s, label) ->
                            FilterChip(
                                selected = settings.sensitivity == s,
                                onClick = { scope.launch { container.settings.update { it.copy(sensitivity = s) } } },
                                label = { Text(stringResource(label)) },
                            )
                        }
                    }
                    Text(stringResource(R.string.sens_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            // Monitored apps
            item { SectionTitle(stringResource(R.string.settings_monitored)) }
            item {
                SettingsCard {
                    Text(stringResource(R.string.settings_monitored_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val all = (DefaultPackages.ALL + settings.monitoredPackages).sorted()
                    all.forEach { pkg ->
                        val checked = pkg in settings.monitoredPackages
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                scope.launch {
                                    container.settings.update {
                                        it.copy(monitoredPackages = if (checked) it.monitoredPackages - pkg else it.monitoredPackages + pkg)
                                    }
                                }
                            },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = checked, onCheckedChange = null)
                            Spacer(Modifier.width(6.dp))
                            Column {
                                Text(appLabel(context, pkg) ?: pkg, style = MaterialTheme.typography.bodyMedium)
                                Text(pkg, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                    AddValueRow(stringResource(R.string.settings_add_package)) { value ->
                        scope.launch { container.settings.update { it.copy(monitoredPackages = it.monitoredPackages + value.trim()) } }
                    }
                }
            }

            // Lists
            item { SectionTitle(stringResource(R.string.settings_lists)) }
            item { ListSection(container, ListKind.ALLOW_SENDER, stringResource(R.string.list_allow)) }
            item { ListSection(container, ListKind.BLOCK_SENDER, stringResource(R.string.list_block)) }
            item { ListSection(container, ListKind.BLOCK_DOMAIN, stringResource(R.string.list_domains)) }
            item { ListSection(container, ListKind.BLOCK_FINGERPRINT, stringResource(R.string.list_block_fingerprints)) }
            item { ListSection(container, ListKind.KNOWN_GOOD_FINGERPRINT, stringResource(R.string.list_fingerprints)) }
            item {
                OutlinedButton(onClick = { importLauncher.launch(arrayOf("*/*")) }, modifier = Modifier.fillMaxWidth()) {
                    Icon(painterResource(R.drawable.ic_add), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.settings_import))
                }
            }

            // Permissions, data, about
            item { SectionTitle(stringResource(R.string.settings_permissions)) }
            item {
                OutlinedButton(onClick = onOpenOnboarding, modifier = Modifier.fillMaxWidth()) {
                    Icon(painterResource(R.drawable.ic_lock), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.settings_permissions))
                }
            }
            item {
                val exportTitle = stringResource(R.string.settings_export_feedback)
                val exportEmpty = stringResource(R.string.settings_export_feedback_empty)
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            val csv = (container as? app.mirsad.shield.data.RoomContainer)?.trainingExport?.exportCsv().orEmpty()
                            if (csv.lines().count { it.isNotBlank() } <= 1) {
                                Toast.makeText(context, exportEmpty, Toast.LENGTH_SHORT).show()
                            } else {
                                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(android.content.Intent.EXTRA_SUBJECT, "mirsad-feedback.csv")
                                    putExtra(android.content.Intent.EXTRA_TEXT, csv)
                                }
                                runCatching { context.startActivity(android.content.Intent.createChooser(send, exportTitle)) }
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(painterResource(R.drawable.ic_send), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(exportTitle)
                }
            }
            item {
                OutlinedButton(
                    onClick = { confirmDelete = true }, modifier = Modifier.fillMaxWidth(),
                    colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Icon(painterResource(R.drawable.ic_delete), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.settings_delete_all))
                }
            }
            item { SectionTitle(stringResource(R.string.settings_about)) }
            item {
                SettingsCard {
                    Text(stringResource(R.string.about_body), style = MaterialTheme.typography.bodyMedium)
                    Text(
                        stringResource(R.string.about_versions, BuildConfig.VERSION_NAME, container.engine::class.simpleName ?: "engine") +
                            " · " + stringResource(R.string.about_no_internet),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.delete_confirm_title)) },
            text = { Text(stringResource(R.string.delete_confirm_body)) },
            confirmButton = {
                Button(
                    onClick = {
                        confirmDelete = false
                        scope.launch {
                            container.incidents.deleteAll()
                            container.lists.deleteAll()
                            container.feedback.deleteAll()
                            app.mirsad.shield.report.ReportActions.deleteSavedReports(context)
                            androidx.core.app.NotificationManagerCompat.from(context).cancelAll()
                            Toast.makeText(context, deletedToast, Toast.LENGTH_SHORT).show()
                        }
                    },
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text(stringResource(R.string.delete_confirm_yes)) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
    }
}

@Composable
private fun ListSection(container: AppContainer, kind: ListKind, title: String) {
    val scope = rememberCoroutineScope()
    val entries by remember(kind) { container.lists.observe(kind) }.collectAsStateWithLifecycle(initialValue = emptyList())
    var expanded by rememberSaveable(kind) { mutableStateOf(false) }
    SettingsCard {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(
                    if (entries.isEmpty()) stringResource(R.string.list_empty) else stringResource(R.string.list_count, entries.size),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(painterResource(if (expanded) R.drawable.ic_close else R.drawable.ic_add), null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (expanded) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            entries.forEach { e ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(e.value, style = MaterialTheme.typography.bodyMedium, fontFamily = if (kind.name.contains("FINGERPRINT")) FontFamily.Monospace else FontFamily.Default)
                        Text(e.origin + (e.note?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { scope.launch { container.lists.remove(e.id) } }) {
                        Icon(painterResource(R.drawable.ic_delete), contentDescription = stringResource(R.string.action_remove), tint = MaterialTheme.colorScheme.error)
                    }
                }
            }
            AddValueRow(stringResource(R.string.list_add_hint)) { raw ->
                val value = normaliseListValue(kind, raw)
                if (value.isNotEmpty()) {
                    scope.launch { container.lists.add(ListEntry(kind = kind, value = value, createdAt = System.currentTimeMillis(), origin = "user")) }
                }
            }
        }
    }
}

/** Light normalisation to the contract's expectations: numbers without spaces/dashes, everything else lowercase. */
private fun normaliseListValue(kind: ListKind, raw: String): String {
    val t = raw.trim()
    if (t.isEmpty()) return ""
    val looksLikeNumber = t.all { it.isDigit() || it == '+' || it == ' ' || it == '-' } && t.any { it.isDigit() }
    return when {
        looksLikeNumber -> t.filter { it.isDigit() || it == '+' }
        kind == ListKind.BLOCK_DOMAIN -> t.lowercase().removePrefix("http://").removePrefix("https://").substringBefore('/')
        else -> t.lowercase()
    }
}

@Composable
private fun AddValueRow(label: String, onAdd: (String) -> Unit) {
    var value by rememberSaveable { mutableStateOf("") }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(value = value, onValueChange = { value = it }, label = { Text(label) }, singleLine = true, modifier = Modifier.weight(1f))
        Button(onClick = { onAdd(value); value = "" }, enabled = value.isNotBlank()) { Text(stringResource(R.string.action_add)) }
    }
    Spacer(Modifier.height(2.dp))
}
