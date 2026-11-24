package app.mirsad.shield.ui.screens

import android.widget.Toast
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.ReportPreview
import app.mirsad.shield.AppContainer
import app.mirsad.shield.BuildConfig
import app.mirsad.shield.R
import app.mirsad.shield.report.ReportActions
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.components.SectionTitle

@Composable
fun ReportScreen(container: AppContainer, incidentId: Long, onBack: () -> Unit) {
    val incident by produceState<Incident?>(initialValue = null, incidentId) { value = container.incidents.get(incidentId) }
    Scaffold(topBar = { MirsadTopBar(stringResource(R.string.report_title), onBack = onBack) }) { padding ->
        val inc = incident
        if (inc == null) {
            Box(Modifier.fillMaxSize().padding(padding))
        } else {
            ReportBody(container, inc, Modifier.padding(padding))
        }
    }
}

@Composable
private fun ReportBody(container: AppContainer, incident: Incident, modifier: Modifier) {
    val context = LocalContext.current
    val hasFalsePositive = incident.feedback == FeedbackVerdict.FALSE_POSITIVE
    var tab by rememberSaveable { mutableStateOf(0) }
    var includeText by rememberSaveable { mutableStateOf(false) }
    val now = remember { System.currentTimeMillis() }

    // Build the report for the selected tab; re-rendered when the checkbox changes.
    val arabic = androidx.compose.ui.platform.LocalConfiguration.current.locales[0].language == "ar"
    val (json, preview) = remember(incident, includeText, tab, hasFalsePositive, arabic) {
        val reports = container.reports
        if (tab == 1 && hasFalsePositive) {
            val r = reports.falsePositiveReport(incident, includeText, BuildConfig.VERSION_NAME, now)
            reports.toJson(r) to (if (arabic) app.mirsad.core.report.ReportPreviewText.ar(r) else reports.preview(r))
        } else {
            val r = reports.scamReport(incident, includeText, BuildConfig.VERSION_NAME, now)
            reports.toJson(r) to (if (arabic) app.mirsad.core.report.ReportPreviewText.ar(r) else reports.preview(r))
        }
    }
    val disabledReason = remember(incident) { ReportActions.amanDisabledReason(incident) }
    val shareFailed = stringResource(R.string.report_share_failed)
    val amanFailed = stringResource(R.string.report_aman_failed)
    val emailSubject = stringResource(R.string.report_email_subject)

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (hasFalsePositive) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.report_tab_scam)) })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.report_tab_fp)) })
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = includeText, onCheckedChange = { includeText = it })
            Text(stringResource(R.string.report_include_text), style = MaterialTheme.typography.bodyLarge)
        }

        SectionTitle(stringResource(R.string.report_json_label))
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
            shape = MaterialTheme.shapes.medium,
        ) {
            SelectionContainer {
                Text(
                    json,
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 360.dp)
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState())
                        .padding(14.dp),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Start,
                )
            }
        }

        PreviewLists(preview)

        Button(
            onClick = {
                val ok = ReportActions.shareJson(context, "mirsad-report-${incident.id}", json)
                if (!ok) Toast.makeText(context, shareFailed, Toast.LENGTH_SHORT).show()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(painterResource(R.drawable.ic_share), null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.report_share))
        }

        SectionTitle(stringResource(R.string.report_aman_title))
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.report_aman_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val enabled = disabledReason == null
                val summary = remember(incident) { container.reports.amanSummary(incident) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { if (!ReportActions.dialAman(context)) Toast.makeText(context, amanFailed, Toast.LENGTH_SHORT).show() },
                        enabled = enabled, modifier = Modifier.weight(1f),
                    ) { Text(stringResource(R.string.report_aman_call), maxLines = 1) }
                    OutlinedButton(
                        onClick = { if (!ReportActions.smsAman(context, summary)) Toast.makeText(context, amanFailed, Toast.LENGTH_SHORT).show() },
                        enabled = enabled, modifier = Modifier.weight(1f),
                    ) { Text(stringResource(R.string.report_aman_sms), maxLines = 1) }
                }
                OutlinedButton(
                    onClick = { if (!ReportActions.emailAman(context, emailSubject, summary)) Toast.makeText(context, amanFailed, Toast.LENGTH_SHORT).show() },
                    enabled = enabled, modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(painterResource(R.drawable.ic_email), null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.report_aman_email))
                }
                if (disabledReason != null) {
                    Text(stringResource(R.string.report_aman_disabled), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun PreviewLists(preview: ReportPreview) {
    Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.medium) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.report_included), style = MaterialTheme.typography.titleMedium)
            preview.included.forEach { BulletLine(it, R.drawable.ic_check, MaterialTheme.colorScheme.primary) }
            Spacer(Modifier.height(6.dp))
            Text(stringResource(R.string.report_excluded), style = MaterialTheme.typography.titleMedium)
            preview.excluded.forEach { BulletLine(it, R.drawable.ic_close, MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun BulletLine(text: String, icon: Int, tint: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(painterResource(icon), null, Modifier.padding(top = 3.dp).size(16.dp), tint = tint)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}
