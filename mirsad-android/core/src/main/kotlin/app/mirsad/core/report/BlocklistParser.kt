package app.mirsad.core.report

import app.mirsad.core.contract.BlocklistFile
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Parses a blocklist import file (see app/src/main/assets/blocklist_example.json) and normalises its entries.
 * Lenient: unknown keys are ignored, missing lists are empty, nulls fall back to defaults.
 */
object BlocklistParser {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }

    /** The normalised file plus the entries that were dropped because they could not be normalised. */
    data class Normalised(val file: BlocklistFile, val dropped: Int, val droppedValues: List<String> = emptyList())

    /** @throws IllegalArgumentException with a short message when [text] is not a blocklist file. */
    fun parse(text: String): BlocklistFile {
        val body = text.trim().removePrefix("﻿").trim()
        if (body.isEmpty()) throw IllegalArgumentException("The file is empty")
        return try {
            json.decodeFromString(BlocklistFile.serializer(), body)
        } catch (e: SerializationException) {
            throw IllegalArgumentException("Not a blocklist file: ${e.message?.lineSequence()?.firstOrNull() ?: "invalid JSON"}", e)
        }
    }

    /**
     * Numbers to E.164 (default UAE), domains to lowercase registrable domains, fingerprints to lowercase 16-hex.
     * Invalid entries are dropped and counted; duplicates collapse.
     */
    fun normalise(file: BlocklistFile, defaultCountryCode: String = ArtifactNormaliser.DEFAULT_COUNTRY_CODE): Normalised {
        val dropped = mutableListOf<String>()
        fun clean(values: List<String>, f: (String) -> String?): List<String> =
            values.mapNotNull { raw -> f(raw).also { if (it == null) dropped += raw } }.distinct()
        val numbers = clean(file.numbers) { ArtifactNormaliser.phone(it, defaultCountryCode) }
        val domains = clean(file.domains) { ArtifactNormaliser.domain(it) }
        val fingerprints = clean(file.fingerprints) { ArtifactNormaliser.fingerprint(it) }
        return Normalised(
            file = file.copy(numbers = numbers, domains = domains, fingerprints = fingerprints),
            dropped = dropped.size,
            droppedValues = dropped,
        )
    }

    fun parseAndNormalise(text: String, defaultCountryCode: String = ArtifactNormaliser.DEFAULT_COUNTRY_CODE): Normalised =
        normalise(parse(text), defaultCountryCode)
}
