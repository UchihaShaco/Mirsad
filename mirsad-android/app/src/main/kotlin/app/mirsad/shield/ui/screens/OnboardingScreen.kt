package app.mirsad.shield.ui.screens

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.mirsad.core.contract.Level
import app.mirsad.shield.R
import app.mirsad.shield.ui.PermissionIntents
import app.mirsad.shield.ui.ProtectionStatus
import app.mirsad.shield.ui.components.MirsadTopBar
import app.mirsad.shield.ui.theme.levelColors

/** Three permission cards with live status, plus Skip / Continue. [onDone] marks onboarding complete. */
@Composable
fun OnboardingScreen(onDone: () -> Unit, onBack: (() -> Unit)?) {
    val context = LocalContext.current
    var status by remember { mutableStateOf(ProtectionStatus.read(context)) }
    val refresh = { status = ProtectionStatus.read(context) }
    LifecycleResumeEffect(Unit) {
        refresh()
        onPauseOrDispose { }
    }
    val roleLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { refresh() }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }
    val unavailable = stringResource(R.string.status_unavailable)

    Scaffold(topBar = { MirsadTopBar(stringResource(R.string.onboarding_title), onBack = onBack) }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.onboarding_intro), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)

            PermissionCard(
                icon = R.drawable.ic_call,
                title = stringResource(R.string.onb_call_title),
                why = stringResource(R.string.onb_call_why),
                on = status.callScreening,
                available = status.callScreeningAvailable,
                onGrant = {
                    val intent = PermissionIntents.requestCallScreening(context)
                    if (intent == null) Toast.makeText(context, unavailable, Toast.LENGTH_SHORT).show() else roleLauncher.launch(intent)
                },
            )
            PermissionCard(
                icon = R.drawable.ic_notifications,
                title = stringResource(R.string.onb_notif_title),
                why = stringResource(R.string.onb_notif_why),
                on = status.notificationAccess,
                available = true,
                buttonLabel = stringResource(R.string.onb_open_settings),
                hint = stringResource(R.string.onb_restricted_hint),
                onGrant = { safeStart(context, PermissionIntents.notificationListenerSettings()) },
            )
            PermissionCard(
                icon = R.drawable.ic_shield,
                title = stringResource(R.string.onb_post_title),
                why = stringResource(R.string.onb_post_why),
                on = status.postNotifications,
                available = true,
                onGrant = {
                    if (PermissionIntents.needsRuntimePostPermission) {
                        permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        safeStart(context, PermissionIntents.appNotificationSettings(context))
                    }
                },
                onOpenSettings = { safeStart(context, PermissionIntents.appNotificationSettings(context)) },
            )

            Spacer(Modifier.height(4.dp))
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.onb_continue)) }
            TextButton(onClick = onDone, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.onb_skip), textAlign = TextAlign.Center)
            }
        }
    }
}

private fun safeStart(context: Context, intent: Intent) {
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, R.string.status_unavailable, Toast.LENGTH_SHORT).show()
    }
}

@Composable
private fun PermissionCard(
    icon: Int,
    title: String,
    why: String,
    on: Boolean,
    available: Boolean,
    onGrant: () -> Unit,
    buttonLabel: String = stringResource(R.string.onb_grant),
    hint: String? = null,
    onOpenSettings: (() -> Unit)? = null,
) {
    val colours = levelColors(if (on) Level.ALLOW else Level.WARN)
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), shape = MaterialTheme.shapes.large) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(icon), null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(10.dp))
                Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(if (on) R.drawable.ic_check_circle else R.drawable.ic_close), null, Modifier.size(18.dp), tint = colours.accent)
                    Spacer(Modifier.width(4.dp))
                    Text(
                        stringResource(if (!available) R.string.status_unavailable else if (on) R.string.status_on else R.string.status_off),
                        style = MaterialTheme.typography.labelLarge, color = colours.accent,
                    )
                }
            }
            Text(why, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!on && available) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = onGrant) { Text(buttonLabel) }
                    if (onOpenSettings != null) TextButton(onClick = onOpenSettings) { Text(stringResource(R.string.onb_open_settings)) }
                }
            }
        }
    }
}
