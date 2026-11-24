package app.mirsad.shield.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mirsad.core.contract.Level

/** Calm, trustworthy palette: deep teal primary; amber for WARN, deep red for HOLD, green for ALLOW. */
private val LightColors: ColorScheme = lightColorScheme(
    primary = Color(0xFF0E4D45),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFBDEEE4),
    onPrimaryContainer = Color(0xFF00201C),
    secondary = Color(0xFF4B635E),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFCDE8E1),
    onSecondaryContainer = Color(0xFF06201B),
    tertiary = Color(0xFF6B5B2E),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFF5E0A6),
    onTertiaryContainer = Color(0xFF231B00),
    error = Color(0xFF9C1C1C),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = Color(0xFFF6FAF8),
    onBackground = Color(0xFF191C1B),
    surface = Color(0xFFF6FAF8),
    onSurface = Color(0xFF191C1B),
    surfaceVariant = Color(0xFFDBE5E1),
    onSurfaceVariant = Color(0xFF3F4945),
    outline = Color(0xFF6F7975),
    outlineVariant = Color(0xFFBEC9C5),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF0F5F3),
    surfaceContainer = Color(0xFFEAEFED),
    surfaceContainerHigh = Color(0xFFE4EAE7),
    surfaceContainerHighest = Color(0xFFDEE4E1),
)

private val DarkColors: ColorScheme = darkColorScheme(
    primary = Color(0xFF8ED6C8),
    onPrimary = Color(0xFF00382F),
    primaryContainer = Color(0xFF0E4D45),
    onPrimaryContainer = Color(0xFFBDEEE4),
    secondary = Color(0xFFB1CCC5),
    onSecondary = Color(0xFF1C352F),
    secondaryContainer = Color(0xFF334B46),
    onSecondaryContainer = Color(0xFFCDE8E1),
    tertiary = Color(0xFFDAC48B),
    onTertiary = Color(0xFF3B2F05),
    tertiaryContainer = Color(0xFF53451A),
    onTertiaryContainer = Color(0xFFF5E0A6),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF0F1413),
    onBackground = Color(0xFFDFE4E1),
    surface = Color(0xFF0F1413),
    onSurface = Color(0xFFDFE4E1),
    surfaceVariant = Color(0xFF3F4945),
    onSurfaceVariant = Color(0xFFBEC9C5),
    outline = Color(0xFF89938F),
    outlineVariant = Color(0xFF3F4945),
    surfaceContainerLowest = Color(0xFF0A0F0E),
    surfaceContainerLow = Color(0xFF171C1B),
    surfaceContainer = Color(0xFF1B201F),
    surfaceContainerHigh = Color(0xFF252B29),
    surfaceContainerHighest = Color(0xFF303634),
)

/** Colours for one decision level: a strong accent, a soft container and the text on it. */
@Immutable
data class LevelColors(val accent: Color, val container: Color, val onContainer: Color)

@Immutable
data class LevelPalette(val allow: LevelColors, val warn: LevelColors, val hold: LevelColors) {
    fun of(level: Level): LevelColors = when (level) {
        Level.ALLOW -> allow
        Level.WARN -> warn
        Level.HOLD -> hold
    }
}

private val LightLevels = LevelPalette(
    allow = LevelColors(Color(0xFF2E7D32), Color(0xFFD7F0D8), Color(0xFF0B2E0E)),
    warn = LevelColors(Color(0xFFA85F00), Color(0xFFFFE9C2), Color(0xFF3A2300)),
    hold = LevelColors(Color(0xFFA4231B), Color(0xFFFFDAD6), Color(0xFF410002)),
)

private val DarkLevels = LevelPalette(
    allow = LevelColors(Color(0xFF8BD48F), Color(0xFF1B3A1E), Color(0xFFCDEFCF)),
    warn = LevelColors(Color(0xFFFFC46B), Color(0xFF4A3200), Color(0xFFFFE9C2)),
    hold = LevelColors(Color(0xFFFF8A80), Color(0xFF5C1410), Color(0xFFFFDAD6)),
)

val LocalLevelPalette = staticCompositionLocalOf { LightLevels }

/** Shortcut: colours for [level] under the current theme. */
@Composable
fun levelColors(level: Level): LevelColors = LocalLevelPalette.current.of(level)

private val MirsadShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Default Material 3 type scale, body sizes nudged up for readability in both scripts. */
private val MirsadTypography: Typography = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.SemiBold),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = t.titleMedium.copy(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = t.bodyLarge.copy(fontSize = 17.sp, lineHeight = 25.sp),
        bodyMedium = t.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
        labelLarge = t.labelLarge.copy(fontSize = 15.sp),
    )
}

@Composable
fun MirsadTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalLevelPalette provides if (darkTheme) DarkLevels else LightLevels) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = MirsadTypography,
            shapes = MirsadShapes,
            content = content,
        )
    }
}
