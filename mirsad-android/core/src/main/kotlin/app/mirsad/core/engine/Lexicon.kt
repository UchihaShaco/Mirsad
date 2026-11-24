package app.mirsad.core.engine

import kotlinx.serialization.Serializable

@Serializable
data class LexiconFile(val version: String = "unknown", val entities: List<EntitySpec> = emptyList())

@Serializable
data class EntitySpec(
    val id: String,
    val category: String,
    val names: List<String> = emptyList(),
    val brandTokens: List<String> = emptyList(),
    val domains: List<String> = emptyList(),
)

@Serializable
data class OfficialDomainsFile(
    val note: String? = null,
    val government: List<String> = emptyList(),
    val telecom: List<String> = emptyList(),
    val banks: List<String> = emptyList(),
    val couriers: List<String> = emptyList(),
    /** Public suffixes (e.g. gov.ae) under which every registrable domain counts as official. */
    val officialSuffixes: List<String> = emptyList(),
)

/** A UAE entity that scammers impersonate, with a compiled whole-word name matcher. */
class Entity(val id: String, val category: String, val namePattern: Regex?, val brandTokens: List<String>, val domains: Set<String>)

/**
 * Entities, their official registrable domains and brand tokens. Built once; immutable.
 */
class Lexicon(
    lexicon: LexiconFile,
    official: OfficialDomainsFile,
    private val normaliser: TextNormaliser = TextNormaliser(),
) {
    val version: String = lexicon.version

    val entities: List<Entity> = lexicon.entities.map { spec ->
        val names = spec.names.map { normaliser.normalise(it) }.filter { it.isNotEmpty() }.sortedByDescending { it.length }
        val pattern = if (names.isEmpty()) null else {
            val alternation = names.joinToString("|") { Regex.escape(it) }
            // Whole-word match; an attached Arabic one-letter prefix (و ف ب ل ك) is allowed before the name.
            Regex("(?<![\\p{L}\\p{N}&])(?:[وفبلك])?(?:$alternation)(?![\\p{L}\\p{N}&])")
        }
        Entity(spec.id, spec.category, pattern, spec.brandTokens.map { it.lowercase() }, spec.domains.map { it.lowercase() }.toSet())
    }

    /** Registrable domains known to be official (file lists plus every entity's domains). */
    val officialDomains: Set<String> = buildSet {
        addAll(official.government); addAll(official.telecom); addAll(official.banks); addAll(official.couriers)
        lexicon.entities.forEach { addAll(it.domains) }
    }.map { it.lowercase().trim() }.filter { it.isNotEmpty() }.toHashSet()

    val officialSuffixes: Set<String> = official.officialSuffixes.map { it.lowercase() }.toHashSet()

    /** (token, entityId) pairs for the brand-in-host rule. */
    val brandTokens: List<Pair<String, String>> = entities.flatMap { e -> e.brandTokens.map { it to e.id } }

    fun isOfficial(registrableDomain: String): Boolean {
        if (registrableDomain in officialDomains) return true
        return officialSuffixes.any { suffix -> registrableDomain.endsWith(".$suffix") }
    }

    /** Entities named in an already-normalised text. */
    fun findEntities(normalised: String): List<Entity> {
        if (normalised.isEmpty()) return emptyList()
        return entities.filter { e -> e.namePattern?.containsMatchIn(normalised) == true }
    }

    companion object {
        fun loadFromResources(normaliser: TextNormaliser = TextNormaliser()): Lexicon {
            val lex = runCatching { Resources.readText("/lexicon.json") }.getOrNull()
                ?.let { runCatching { RuleSet.json.decodeFromString(LexiconFile.serializer(), it) }.getOrNull() }
                ?: LexiconFile(version = "missing")
            val official = runCatching { Resources.readText("/official_domains.json") }.getOrNull()
                ?.let { runCatching { RuleSet.json.decodeFromString(OfficialDomainsFile.serializer(), it) }.getOrNull() }
                ?: OfficialDomainsFile()
            return Lexicon(lex, official, normaliser)
        }
    }
}
