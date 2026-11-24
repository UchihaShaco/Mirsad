package app.mirsad.core.cli

import app.mirsad.core.MirsadEngineFactory
import app.mirsad.core.contract.Channel
import app.mirsad.core.contract.EngineContext
import app.mirsad.core.contract.Event
import app.mirsad.core.contract.Sensitivity
import java.io.File

/**
 * Laptop-side command-line demo of the same engine the app ships (rules + classifier + HOLD gate).
 *
 *   scripts/analyse.sh "<sender>" "<text>" [SMS|CHAT|CALL] [RELAXED|BALANCED|STRICT]
 *   scripts/analyse.sh --file messages.tsv        one message per line: channel<TAB>sender<TAB>text
 *
 * A sender made of letters and spaces with a lower-case letter (e.g. "Khalid") is treated as a saved
 * contact, exactly as the notification listener does. Prints one line per message plus the reasons.
 */
fun main(args: Array<String>) {
    val engine = MirsadEngineFactory.create()
    if (args.isEmpty()) {
        System.err.println("usage: analyse <sender> <text> [SMS|CHAT|CALL] [RELAXED|BALANCED|STRICT]  |  analyse --file <tsv> [sensitivity]")
        return
    }
    if (args[0] == "--profile") {
        // Times every rule pattern on the given text: finds regexes that backtrack.
        val text = app.mirsad.core.engine.TextNormaliser(app.mirsad.core.engine.RuleSet.loadFromResources().arabizi).normalise(args[1])
        app.mirsad.core.engine.RuleSet.loadFromResources().allPatterns().map { (label, re) ->
            val t0 = System.nanoTime(); val n = runCatching { re.findAll(text).count() }.getOrElse { -1 }
            Triple(label, (System.nanoTime() - t0) / 1_000_000, n) to re.pattern.take(70)
        }.sortedByDescending { it.first.second }.take(8).forEach { println("${it.first.second}ms\t${it.first.first}\tmatches=${it.first.third}\t${it.second}") }
        return
    }
    if (args[0] == "--file") {
        val sensitivity = args.getOrNull(2)?.let { Sensitivity.valueOf(it.uppercase()) } ?: Sensitivity.BALANCED
        File(args[1]).readLines(Charsets.UTF_8).filter { it.isNotBlank() && !it.startsWith("#") }.forEach { line ->
            val parts = line.split('\t', limit = 3)
            if (parts.size < 3) {
                println("SKIP (need channel<TAB>sender<TAB>text): $line")
            } else {
                analyseOne(engine, parts[1], parts[2], Channel.valueOf(parts[0].trim().uppercase()), sensitivity)
            }
        }
        return
    }
    val sender = args[0]
    val text = args.getOrNull(1).orEmpty()
    val channel = args.getOrNull(2)?.let { Channel.valueOf(it.uppercase()) } ?: Channel.SMS
    val sensitivity = args.getOrNull(3)?.let { Sensitivity.valueOf(it.uppercase()) } ?: Sensitivity.BALANCED
    analyseOne(engine, sender, text, channel, sensitivity)
}

private fun looksLikeContact(sender: String, channel: Channel): Boolean {
    val s = sender.trim()
    if (s.isEmpty() || s.any { it.isDigit() }) return false
    val allCapsId = s.length <= 11 && s.none { it.isLowerCase() } && s.any { it in 'A'..'Z' }
    return !(channel == Channel.SMS && allCapsId) && s.any { it.isLetter() } && !allCapsId
}

private fun analyseOne(
    engine: app.mirsad.core.contract.ScamEngine,
    sender: String,
    text: String,
    channel: Channel,
    sensitivity: Sensitivity,
) {
    val event = Event(
        channel = channel,
        sender = sender,
        text = if (channel == Channel.CALL) null else text,
        appPackage = null,
        timestamp = System.currentTimeMillis(),
        senderLooksLikeContact = looksLikeContact(sender, channel),
    )
    val v = engine.analyse(event, EngineContext(sensitivity = sensitivity, stageOneOnly = channel == Channel.CALL))
    println("${v.level}\tscore=${"%.2f".format(v.score)}\t${v.latencyMs}ms\t$channel\t$sender\t${text.take(90)}")
    v.reasons.sortedByDescending { it.weight }.forEach { r ->
        println("    ${if (r.hard) "HARD " else "     "}${"%+.2f".format(r.weight)}  ${r.code}${r.detail?.let { " ($it)" } ?: ""}")
    }
    if (v.artifacts.isNotEmpty()) println("    artifacts: " + v.artifacts.joinToString { "${it.type}=${it.value}" })
    println("    fingerprint=${v.fingerprint} language=${v.language} model=${v.modelVersion} rules=${v.rulesVersion}")
}
