package app.mirsad.shield.data

import androidx.room.TypeConverter
import app.mirsad.core.contract.Artifact
import app.mirsad.core.contract.Reason
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * Room type converters: reasons, artifacts and reason-code lists are stored as JSON strings.
 * Enums are handled by Room's built-in enum converter (stored by name).
 */
class Converters {
    @TypeConverter
    fun reasonsToJson(value: List<Reason>): String = json.encodeToString(reasonList, value)

    @TypeConverter
    fun jsonToReasons(value: String): List<Reason> = decodeList(reasonList, value)

    @TypeConverter
    fun artifactsToJson(value: List<Artifact>): String = json.encodeToString(artifactList, value)

    @TypeConverter
    fun jsonToArtifacts(value: String): List<Artifact> = decodeList(artifactList, value)

    @TypeConverter
    fun stringsToJson(value: List<String>): String = json.encodeToString(stringList, value)

    @TypeConverter
    fun jsonToStrings(value: String): List<String> = decodeList(stringList, value)

    private fun <T> decodeList(serializer: KSerializer<List<T>>, value: String): List<T> =
        if (value.isBlank()) emptyList() else runCatching { json.decodeFromString(serializer, value) }.getOrDefault(emptyList())

    private companion object {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val reasonList = ListSerializer(Reason.serializer())
        val artifactList = ListSerializer(Artifact.serializer())
        val stringList = ListSerializer(String.serializer())
    }
}
