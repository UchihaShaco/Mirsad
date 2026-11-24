package app.mirsad.shield.report

import android.content.Context
import java.io.IOException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** One reporting channel from assets/report_channels.json. Every value stays "to be confirmed" until the police team confirms it. */
@Serializable
data class ReportChannel(
    val id: String,
    @SerialName("name_en") val nameEn: String = "",
    @SerialName("name_ar") val nameAr: String = "",
    val phone: String? = null,
    val sms: String? = null,
    val email: String? = null,
    val web: String? = null,
    /** "to_be_confirmed" until confirmed with the police team; the UI may show this. */
    val status: String = STATUS_TO_BE_CONFIRMED,
) {
    val confirmed: Boolean get() = status == "confirmed"

    companion object {
        const val STATUS_TO_BE_CONFIRMED = "to_be_confirmed"
    }
}

@Serializable
data class ReportChannelsFile(
    val note: String = "",
    val channels: List<ReportChannel> = emptyList(),
)

/** Reads assets/report_channels.json once. Falls back to the same values compiled in when the asset is unreadable. */
object ReportChannels {
    const val ASSET = "report_channels.json"
    const val AMAN_ID = "adp_aman"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }

    @Volatile
    private var cached: ReportChannelsFile? = null

    private val fallback = ReportChannelsFile(
        note = "To be confirmed with the police team before any real use.",
        channels = listOf(
            ReportChannel(
                id = AMAN_ID,
                nameEn = "Abu Dhabi Police Aman service",
                nameAr = "خدمة أمان - شرطة أبوظبي",
                phone = "8002626",
                sms = "2828",
                email = "aman@adpolice.gov.ae",
            ),
        ),
    )

    fun load(context: Context): ReportChannelsFile {
        cached?.let { return it }
        val loaded = try {
            val text = context.applicationContext.assets.open(ASSET).bufferedReader(Charsets.UTF_8).use { it.readText() }
            json.decodeFromString(ReportChannelsFile.serializer(), text)
        } catch (e: IOException) {
            fallback
        } catch (e: SerializationException) {
            fallback
        } catch (e: IllegalArgumentException) {
            fallback
        }
        cached = loaded
        return loaded
    }

    /** The Abu Dhabi Police Aman channel (phone, SMS, email). Never null: the compiled-in fallback has it. */
    fun aman(context: Context): ReportChannel =
        load(context).channels.firstOrNull { it.id == AMAN_ID } ?: fallback.channels.first()
}
