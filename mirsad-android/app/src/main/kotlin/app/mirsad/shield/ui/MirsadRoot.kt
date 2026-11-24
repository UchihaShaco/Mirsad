package app.mirsad.shield.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.mirsad.shield.AppContainer
import app.mirsad.shield.R

/** Skeleton root. Workstream C replaces this with theme + navigation + all screens. */
@Composable
fun MirsadRoot(container: AppContainer, initialIncidentId: Long?, initialScreen: String?) {
    MaterialTheme {
        Scaffold { padding ->
            Column(Modifier.fillMaxSize().padding(padding).padding(24.dp)) {
                Text(stringResource(R.string.skeleton_title), style = MaterialTheme.typography.headlineLarge)
                Text(stringResource(R.string.skeleton_subtitle), style = MaterialTheme.typography.bodyLarge)
                Text("engine=${container.engine::class.simpleName} incident=$initialIncidentId screen=$initialScreen",
                    style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
