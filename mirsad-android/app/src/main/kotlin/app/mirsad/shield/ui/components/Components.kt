package app.mirsad.shield.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.FeedbackVerdict
import app.mirsad.core.contract.Incident
import app.mirsad.core.contract.Level
import app.mirsad.shield.R
import app.mirsad.shield.ui.bidiSafe
import app.mirsad.shield.ui.channelIcon
import app.mirsad.shield.ui.contentStyle
import app.mirsad.shield.ui.channelLabel
import app.mirsad.shield.ui.levelLabel
import app.mirsad.shield.ui.reasonText
import app.mirsad.shield.ui.relativeTime
import app.mirsad.shield.ui.theme.levelColors
import kotlin.math.abs

/** The Abu Dhabi Police guidance line, shown with every warning and incident view. */
@Composable
fun SafetyLine(modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_shield), contentDescription = null,
            tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            stringResource(R.string.safety_line),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            fontWeight = FontWeight.Medium,
        )
    }
}

/** Small coloured pill with the level name. */
@Composable
fun LevelBadge(level: Level, modifier: Modifier = Modifier, large: Boolean = false) {
    val c = levelColors(level)
    Text(
        levelLabel(level),
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(c.accent)
            .padding(horizontal = if (large) 14.dp else 10.dp, vertical = if (large) 6.dp else 3.dp),
        style = if (large) MaterialTheme.typography.labelLarge else MaterialTheme.typography.labelMedium,
        color = Color.White,
        fontWeight = FontWeight.SemiBold,
    )
}

/** Neutral pill for tags such as "Synthetic · demo" or "Restored". */
@Composable
fun TagPill(text: String, modifier: Modifier = Modifier, container: Color = MaterialTheme.colorScheme.surfaceContainerHighest, content: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(
        text,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(container)
            .padding(horizontal = 10.dp, vertical = 3.dp),
        style = MaterialTheme.typography.labelMedium,
        color = content,
    )
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.padding(top = 8.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onSurface,
    )
}

/** Horizontal bar showing |weight| in [0,1]; safe (negative) signals are green, risk signals use the level colour. */
@Composable
fun WeightBar(weight: Double, level: Level, modifier: Modifier = Modifier) {
    val fraction = abs(weight).coerceIn(0.0, 1.0).toFloat()
    val colour = if (weight < 0) levelColors(Level.ALLOW).accent else levelColors(if (level == Level.ALLOW) Level.WARN else level).accent
    Box(
        modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceAtLeast(0.02f))
                .height(6.dp)
                .clip(RoundedCornerShape(50))
                .background(colour),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MirsadTopBar(title: String, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(painterResource(R.drawable.ic_back), contentDescription = stringResource(R.string.action_back))
                }
            }
        },
        actions = { actions() },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
    )
}

/** One incident in a list: level badge, channel, sender, first line, top reasons, time. */
@Composable
fun IncidentRow(incident: Incident, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = levelColors(incident.level)
    Card(
        modifier = modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(c.container),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(channelIcon(incident.channel)), contentDescription = channelLabel(incident.channel), tint = c.accent, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    LevelBadge(incident.level)
                    if (incident.feedback == FeedbackVerdict.FALSE_POSITIVE) TagPill(stringResource(R.string.restored_tag))
                    if (incident.synthetic) TagPill(stringResource(R.string.synthetic_badge))
                }
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        bidiSafe(incident.sender.ifBlank { stringResource(R.string.unknown_sender) }),
                        style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(relativeTime(incident.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                val firstLine = when {
                    incident.channel == Channel.CALL -> stringResource(R.string.row_call)
                    incident.text.isNullOrBlank() -> stringResource(R.string.row_no_text)
                    else -> incident.text!!.lineSequence().first()
                }
                Text(firstLine, style = contentStyle(MaterialTheme.typography.bodyMedium, firstLine), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val top = incident.reasons.filter { it.weight > 0 }.sortedByDescending { it.weight }.take(2)
                if (top.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        top.map { reasonText(it) }.joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium, color = c.accent, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
