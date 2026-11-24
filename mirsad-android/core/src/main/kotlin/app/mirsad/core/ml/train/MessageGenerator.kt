package app.mirsad.core.ml.train

import kotlin.random.Random

/**
 * Deterministic generator of synthetic UAE-style scam and legitimate messages from templates.
 * Same seed, same output. Every number is zero-filled fiction, every scam domain ends in `.example`,
 * and legitimate messages link only to the official hosts listed in [Entities].
 */
class MessageGenerator(private val seed: Int = DEFAULT_SEED) {

    enum class Lang(val code: String) { EN("en"), AR("ar"), AR_LATN("ar-latn") }

    /** A UAE entity in both scripts. [officialHost] is null when no host from the allowed list applies. */
    class Entity(val en: String, val ar: String, val senderId: String, val officialHost: String?, val slug: String) {
        fun name(lang: Lang): String = if (lang == Lang.AR) ar else en
    }

    object Entities {
        val ADCB = Entity("ADCB", "بنك أبوظبي التجاري", "ADCB", "adcb.com", "adcb")
        val FAB = Entity("FAB", "بنك أبوظبي الأول", "FAB", "bankfab.com", "fab")
        val ADIB = Entity("ADIB", "مصرف أبوظبي الإسلامي", "ADIB", "adib.ae", "adib")
        val ENBD = Entity("Emirates NBD", "بنك الإمارات دبي الوطني", "EmiratesNBD", "emiratesnbd.com", "emiratesnbd")
        val MASHREQ = Entity("Mashreq", "بنك المشرق", "Mashreq", "mashreq.com", "mashreq")
        val DEWA = Entity("DEWA", "هيئة كهرباء ومياه دبي", "DEWA", "dewa.gov.ae", "dewa")
        val ADDC = Entity("ADDC", "شركة أبوظبي للتوزيع", "ADDC", "addc.ae", "addc")
        val SALIK = Entity("Salik", "سالك", "SALIK", "salik.ae", "salik")
        val RTA = Entity("RTA", "هيئة الطرق والمواصلات", "RTA", "rta.ae", "rta")
        val MAWAQIF = Entity("Mawaqif", "مواقف", "MAWAQIF", null, "mawaqif")
        val DARB = Entity("Darb", "درب", "DARB", null, "darb")
        val EMIRATES_POST = Entity("Emirates Post", "بريد الإمارات", "EmiratesPost", "emiratespost.ae", "emiratespost")
        val ARAMEX = Entity("Aramex", "أرامكس", "Aramex", "aramex.com", "aramex")
        val ETISALAT = Entity("Etisalat by e&", "اتصالات من e&", "etisalat", "etisalat.ae", "etisalat")
        val DU = Entity("du", "دو", "du", "du.ae", "du")
        val ICP = Entity("ICP", "الهيئة الاتحادية للهوية والجنسية", "ICP", "icp.gov.ae", "icp")
        val UAE_PASS = Entity("UAE Pass", "الهوية الرقمية UAE Pass", "UAEPASS", "uaepass.ae", "uaepass")
        val TAMM = Entity("TAMM", "تم", "TAMM", "tamm.abudhabi", "tamm")
        val AD_POLICE = Entity("Abu Dhabi Police", "شرطة أبوظبي", "ADPolice", "adpolice.gov.ae", "adpolice")
        val DUBAI_POLICE = Entity("Dubai Police", "شرطة دبي", "DubaiPolice", null, "dubaipolice")

        val BANKS = listOf(ADCB, FAB, ADIB, ENBD, MASHREQ)
        val UTILITIES = listOf(DEWA, ADDC)
        val TOLLS = listOf(SALIK, RTA)
        val PARKING = listOf(MAWAQIF, DARB)
        val COURIERS = listOf(EMIRATES_POST, ARAMEX)
        val TELECOMS = listOf(ETISALAT, DU)
        val IDENTITY = listOf(ICP, UAE_PASS)
        val GOVERNMENT = listOf(ICP, UAE_PASS, TAMM)
        val POLICE = listOf(AD_POLICE, DUBAI_POLICE)
        val ALL = BANKS + UTILITIES + TOLLS + PARKING + COURIERS + TELECOMS + GOVERNMENT + POLICE

        /** The only hosts a legitimate generated message may link to. */
        val OFFICIAL_HOSTS: Set<String> = setOf(
            "u.ae", "icp.gov.ae", "adpolice.gov.ae", "rta.ae", "salik.ae", "dewa.gov.ae", "addc.ae", "uaepass.ae",
            "tamm.abudhabi", "emiratespost.ae", "etisalat.ae", "du.ae", "bankfab.com", "emiratesnbd.com", "adcb.com",
            "adib.ae", "mashreq.com", "aramex.com",
        )
    }

    private enum class Sender { ENTITY_ID, SCAM_ANY, FOREIGN_NUMBER, LOCAL_NUMBER, PERSON }

    private class Template(
        val label: String,
        val lang: Lang,
        /** "SMS", "CHAT" or "ANY". */
        val channel: String,
        val entities: List<Entity>,
        val sender: Sender,
        val texts: List<String>,
    )

    private inner class Ctx(val lang: Lang, val entity: Entity?, val rnd: Random) {
        private val memo = HashMap<String, String>()
        fun slot(name: String): String = memo.getOrPut(name) {
            val provider = SLOTS[name] ?: error("unknown slot {$name}")
            provider(this)
        }
        fun <T> pick(list: List<T>): T = list[rnd.nextInt(list.size)]
        fun pick(vararg options: String): String = options[rnd.nextInt(options.size)]
        fun byLang(en: List<String>, ar: List<String>, latn: List<String> = en): String = pick(
            when (lang) {
                Lang.EN -> en
                Lang.AR -> ar
                Lang.AR_LATN -> latn
            },
        )
        fun twoDigits(): String = "%02d".format(rnd.nextInt(100))
    }

    /** Generates [scamCount] scam rows and [legitCount] legitimate rows; texts are unique within the output. */
    fun generate(scamCount: Int, legitCount: Int): List<LabelledMessage> {
        val rnd = Random(seed)
        val seen = HashSet<String>()
        val out = ArrayList<LabelledMessage>(scamCount + legitCount)
        out += produce(SCAM_TEMPLATES, scamCount, mapOf(Lang.EN to 0.40, Lang.AR to 0.35, Lang.AR_LATN to 0.25), rnd, seen)
        out += produce(LEGIT_TEMPLATES, legitCount, mapOf(Lang.EN to 0.42, Lang.AR to 0.36, Lang.AR_LATN to 0.22), rnd, seen)
        return out
    }

    private fun produce(
        templates: List<Template>,
        count: Int,
        weights: Map<Lang, Double>,
        rnd: Random,
        seen: MutableSet<String>,
    ): List<LabelledMessage> {
        val byLang = templates.groupBy { it.lang }
        val quota = LinkedHashMap<Lang, Int>()
        var assigned = 0
        for (lang in listOf(Lang.EN, Lang.AR)) {
            val n = Math.round(count * (weights[lang] ?: 0.0)).toInt()
            quota[lang] = n
            assigned += n
        }
        quota[Lang.AR_LATN] = count - assigned

        val result = ArrayList<LabelledMessage>(count)
        for ((lang, n) in quota) {
            // Round-robin over every (template, variant) pair so each phrasing gets the same share of rows.
            val pool = (byLang[lang] ?: continue).flatMap { t -> t.texts.map { t to it } }
            var produced = 0
            var attempts = 0
            var cursor = rnd.nextInt(pool.size)
            while (produced < n && attempts < n * 200) {
                attempts++
                val (t, variant) = pool[cursor % pool.size]
                cursor++
                val entity = if (t.entities.isEmpty()) null else t.entities[rnd.nextInt(t.entities.size)]
                val ctx = Ctx(lang, entity, rnd)
                val text = fill(variant, ctx)
                if (!seen.add(text)) continue
                val channel = if (t.channel == "ANY") ctx.pick("SMS", "CHAT") else t.channel
                result += LabelledMessage(t.label, lang.code, channel, sender(t, ctx), text, synthetic = true)
                produced++
            }
        }
        return result
    }

    private fun fill(template: String, ctx: Ctx): String =
        SLOT_PATTERN.replace(template) { m -> ctx.slot(m.groupValues[1]) }

    private fun sender(t: Template, ctx: Ctx): String = when (t.sender) {
        Sender.ENTITY_ID -> ctx.entity?.senderId ?: ctx.slot("localNumber")
        Sender.FOREIGN_NUMBER -> ctx.slot("foreignNumber")
        Sender.LOCAL_NUMBER -> ctx.slot("localNumber")
        Sender.PERSON -> ctx.byLang(PERSONS_EN, PERSONS_AR, PERSONS_LATN)
        Sender.SCAM_ANY -> when (ctx.rnd.nextInt(4)) {
            0 -> ctx.slot("localNumber")
            1 -> spoofedId(ctx)
            else -> ctx.slot("foreignNumber")
        }
    }

    private fun spoofedId(ctx: Ctx): String {
        val base = ctx.entity?.slug ?: ctx.pick(SCAM_SLUGS)
        val suffix = ctx.pick("-INFO", "-ALERT", "-AE", "-UAE", "-PL", "-SEC")
        return (base.take(8) + suffix).uppercase()
    }

    // ------------------------------------------------------------------------------------------
    // Slot providers
    // ------------------------------------------------------------------------------------------

    private val SLOTS: Map<String, (Ctx) -> String> = mapOf(
        "entity" to { c -> (c.entity ?: c.pick(Entities.ALL)).name(c.lang) },
        "bank" to { c -> c.pick(Entities.BANKS).name(c.lang) },
        "courier" to { c -> c.pick(Entities.COURIERS).name(c.lang) },
        "telecom" to { c -> c.pick(Entities.TELECOMS).name(c.lang) },
        "police" to { c -> c.pick(Entities.POLICE).name(c.lang) },
        "utility" to { c -> c.pick(Entities.UTILITIES).name(c.lang) },
        "officialUrl" to { c -> "https://" + (c.entity?.officialHost ?: "u.ae") },
        "officialHost" to { c -> c.entity?.officialHost ?: "u.ae" },
        "scamurl" to { c -> scamUrl(c) },
        "tme" to { c -> "t.me/" + c.pick("hr_uae_jobs", "vip_signals_ae", "gold_profit_uae", "bank_support_ae", "parttime_dxb", "crypto_club_uae") + "_example" },
        "wame" to { c -> "wa.me/" + c.slot("foreignNumber").removePrefix("+") },
        "foreignNumber" to { c -> foreignNumber(c) },
        "localNumber" to { c -> "+9715" + "000000" + c.twoDigits() },
        "iban" to { c -> "AE07" + "0".repeat(17) + c.twoDigits() },
        "tracking" to { c -> "0".repeat(8) + c.twoDigits() },
        "orderNo" to { c -> "N" + "0".repeat(8) + c.twoDigits() },
        "ref" to { c -> "REQ-" + "0".repeat(6) + c.twoDigits() },
        "last4" to { c -> "00" + c.twoDigits() },
        "code" to { c -> "%06d".format(c.rnd.nextInt(1_000_000)) },
        "amount" to { c -> c.pick("120.00", "250", "1,250.00", "2,000", "3,500", "480.50", "99.00", "760", "5,000", "15,000") },
        "balance" to { c -> c.pick("1,234.56", "8,450.00", "312.75", "25,900.10", "4,080.00", "47.25") },
        "smallfee" to { c -> c.pick("3.50", "5", "7.25", "9.99", "12", "2.75", "15", "4.90") },
        "fine" to { c -> c.pick("150", "300", "500", "1,000", "600", "400", "800") },
        "hours" to { c -> c.pick("12", "24", "48", "6", "2") },
        "minutes" to { c -> c.pick("3", "5", "10", "2") },
        "days" to { c -> c.pick("3", "5", "7", "10", "14") },
        "pct" to { c -> c.pick("15", "20", "25", "30", "40", "50", "70") },
        "prize" to { c -> c.pick("25,000", "50,000", "100,000", "500,000", "1,000,000", "10,000") },
        "dailypay" to { c -> c.pick("300", "500", "800", "1,000", "1,200", "650") },
        "hour" to { c -> c.pick("6", "7", "8", "9", "10", "11", "5", "4") },
        "time" to { c -> c.pick("09:30", "11:00", "14:15", "16:45", "08:00", "13:30", "10:15", "17:00") },
        "window" to { c -> c.byLang(
            listOf("2 PM and 6 PM", "9 AM and 1 PM", "10 AM and 2 PM", "4 PM and 8 PM"),
            listOf("2 و 6 مساءً", "9 صباحاً و 1 ظهراً", "10 صباحاً و 2 ظهراً", "4 و 8 مساءً"),
            listOf("2 w 6 el 3asr", "9 w 1 el sob7", "10 w 2 el dohor"),
        ) },
        "date" to { c -> c.byLang(
            listOf("15 Nov", "26 Nov", "3 Dec", "1 Jan", "28 Oct", "12 Dec", "5 Nov", "20 Jan"),
            listOf("15 نوفمبر", "26 نوفمبر", "3 ديسمبر", "1 يناير", "28 أكتوبر", "12 ديسمبر", "5 نوفمبر", "20 يناير"),
            listOf("15 Nov", "26 Nov", "3 Dec", "1 Jan", "28 Oct"),
        ) },
        "month" to { c -> c.byLang(
            listOf("October", "November", "September", "December", "August"),
            listOf("أكتوبر", "نوفمبر", "سبتمبر", "ديسمبر", "أغسطس"),
            listOf("October", "November", "September"),
        ) },
        "merchant" to { c -> c.byLang(
            listOf("CARREFOUR", "LULU HYPERMARKET", "TALABAT", "ADNOC", "SPINNEYS", "IKEA", "SHARAF DG", "NOON", "ENOC", "WAITROSE"),
            listOf("كارفور", "لولو هايبرماركت", "طلبات", "أدنوك", "سبينيس", "إيكيا", "شرف دي جي", "نون"),
        ) },
        "shop" to { c -> c.byLang(
            listOf("Noon", "Carrefour", "Namshi", "Talabat", "Lulu", "Sharaf DG", "Centrepoint"),
            listOf("نون", "كارفور", "نمشي", "طلبات", "لولو", "سنتربوينت"),
        ) },
        "category" to { c -> c.byLang(
            listOf("electronics", "fashion", "groceries", "beauty", "home appliances", "kids' wear"),
            listOf("الإلكترونيات", "الأزياء", "البقالة", "مستحضرات التجميل", "الأجهزة المنزلية", "ملابس الأطفال"),
        ) },
        "clinic" to { c -> c.byLang(
            listOf("SEHA", "Mediclinic", "NMC Healthcare", "Aster Clinic", "Burjeel", "Cleveland Clinic Abu Dhabi"),
            listOf("صحة", "ميديكلينيك", "إن إم سي", "عيادة أستر", "برجيل", "كليفلاند كلينك أبوظبي"),
        ) },
        "school" to { c -> c.byLang(
            listOf("GEMS Wellington", "Al Ittihad School", "Brighton College", "Raha International School", "Al Yasmina Academy"),
            listOf("مدرسة الاتحاد", "مدرسة الراحة الدولية", "أكاديمية الياسمينة", "مدرسة جيمس ويلينغتون", "كلية برايتون"),
        ) },
        "doctor" to { c -> c.byLang(
            listOf("Ahmed", "Fatima", "Al Mansoori", "Khan", "Hassan", "Siddiqui", "Al Hammadi"),
            listOf("أحمد", "فاطمة", "المنصوري", "خان", "حسن", "الحمادي"),
        ) },
        "childName" to { c -> c.byLang(
            listOf("Omar", "Maryam", "Zayed", "Noor", "Hamdan", "Alia"),
            listOf("عمر", "مريم", "زايد", "نور", "حمدان", "علياء"),
        ) },
        "city" to { c -> c.byLang(
            listOf("Al Ain", "Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Khalifa City", "Al Barsha", "Madinat Zayed"),
            listOf("العين", "أبوظبي", "دبي", "الشارقة", "عجمان", "مدينة خليفة", "البرشاء", "مدينة زايد"),
            listOf("Al Ain", "Abu Dhabi", "Dubai", "Sharjah"),
        ) },
        "prizeItem" to { c -> c.byLang(
            listOf("brand-new iPhone", "Toyota Land Cruiser", "shopping voucher", "Nissan Patrol", "gold bar"),
            listOf("هاتف آيفون جديد", "سيارة لاند كروزر", "قسيمة تسوق", "سيارة نيسان باترول", "سبيكة ذهب"),
            listOf("iPhone jdeed", "Land Cruiser", "voucher", "Patrol"),
        ) },
        "jobTask" to { c -> c.byLang(
            listOf("liking videos", "rating products", "simple data entry", "reviewing hotels", "watching ads", "sharing posts"),
            listOf("الإعجاب بالفيديوهات", "تقييم المنتجات", "إدخال بيانات بسيط", "تقييم الفنادق", "مشاهدة الإعلانات", "مشاركة المنشورات"),
            listOf("like videos", "ta2yeem products", "data entry", "ta2yeem hotels", "shoof e3lanat"),
        ) },
        "asset" to { c -> c.byLang(
            listOf("gold", "crypto", "forex", "Bitcoin", "oil futures", "USDT"),
            listOf("الذهب", "العملات الرقمية", "الفوركس", "البيتكوين", "عقود النفط", "USDT"),
            listOf("gold", "crypto", "forex", "Bitcoin", "USDT"),
        ) },
        "remoteApp" to { c -> c.pick("AnyDesk", "TeamViewer", "QuickSupport", "AirDroid") },
        "parent" to { c -> c.byLang(
            listOf("Mum", "Dad", "Mama", "Baba", "Mom"),
            listOf("ماما", "بابا", "أمي", "أبي", "يمه"),
            listOf("mama", "baba", "yumma", "yuba"),
        ) },
        "fineType" to { c -> c.byLang(
            listOf("traffic", "parking", "speeding", "Salik toll"),
            listOf("مرورية", "وقوف", "سرعة", "سالك"),
            listOf("muroriya", "parking", "sor3a", "salik"),
        ) },
        "penalty" to { c -> c.byLang(
            listOf("surcharge", "late fee", "licence block", "vehicle impound", "black points"),
            listOf("مضاعفة الغرامة", "رسوم تأخير", "حجب الرخصة", "حجز المركبة", "النقاط السوداء"),
            listOf("gharama mod3afa", "7ajez el sayara", "7ajeb el license"),
        ) },
        "zone" to { c -> c.pick("201", "112", "405", "318", "C4", "M3") },
        "courtNo" to { c -> c.pick("1", "2", "3", "4") },
        "grade" to { c -> c.pick("3", "5", "7", "9", "11") },
        "gb" to { c -> c.pick("5", "10", "20", "50") },
        "friend" to { c -> c.byLang(PERSONS_EN, PERSONS_AR, PERSONS_LATN) },
    )

    private fun scamUrl(c: Ctx): String {
        val slug = c.entity?.slug ?: c.pick(SCAM_SLUGS)
        val word = c.pick(SCAM_WORDS)
        val scheme = if (c.rnd.nextInt(3) == 0) "https" else "http"
        val host = when (c.rnd.nextInt(4)) {
            0 -> "$slug-$word.example"
            1 -> "$slug.$word.example"
            2 -> "$word-$slug-ae.example"
            else -> "$slug-ae.$word.example"
        }
        val path = c.pick(SCAM_PATHS)
        return "$scheme://$host" + (if (path.isEmpty()) "" else "/$path")
    }

    private fun foreignNumber(c: Ctx): String {
        val cc = c.pick(FOREIGN_CODES)
        val zeros = 12 - (cc.length - 1) - 2
        return cc + "0".repeat(zeros) + c.twoDigits()
    }

    // ------------------------------------------------------------------------------------------
    // Templates
    // ------------------------------------------------------------------------------------------

    private val SCAM_TEMPLATES: List<Template> = buildList {
        val S = LabelledMessage.LABEL_SCAM
        // --- English ---
        add(Template(S, Lang.EN, "SMS", Entities.COURIERS, Sender.SCAM_ANY, listOf(
            "{entity}: your parcel {tracking} is held at customs. Pay AED {smallfee} within {hours} hours or it will be returned: {scamurl}",
            "{entity} delivery notice: we could not deliver your package due to an unpaid customs fee of AED {smallfee}. Confirm and pay here: {scamurl}",
            "Your {entity} shipment is on hold. A small clearance fee of AED {smallfee} is required to release it: {scamurl}",
            "[{entity}] Your package is waiting for delivery. Update your address and pay the AED {smallfee} redelivery fee within {hours} hours: {scamurl}",
            "Parcel {tracking} could not be delivered because of incomplete address details. Reschedule and pay AED {smallfee}: {scamurl}",
        )))
        add(Template(S, Lang.EN, "SMS", Entities.POLICE, Sender.SCAM_ANY, listOf(
            "{entity}: you have an unpaid {fineType} fine of AED {fine}. Pay within {hours} hours to avoid a {penalty}: {scamurl}",
            "Final notice from {entity}. Your traffic fine of AED {fine} is overdue and your licence will be blocked. Settle now: {scamurl}",
            "{entity} reminder: a {fineType} violation of AED {fine} is registered against your vehicle. Pay today or face {penalty}: {scamurl}",
            "Mawaqif: unpaid parking violation of AED {fine}. Your vehicle will be impounded unless paid today: {scamurl}",
            "RTA: your {fineType} fine of AED {fine} has not been paid. Last chance before {penalty}: {scamurl}",
        )))
        add(Template(S, Lang.EN, "SMS", Entities.BANKS, Sender.SCAM_ANY, listOf(
            "{entity}: your card has been temporarily suspended due to unusual activity. Verify your details within {hours} hours to restore access: {scamurl}",
            "Dear {entity} customer, your account will be deactivated today. Update your information to keep your account active: {scamurl}",
            "{entity} alert: the Emirates ID linked to your account has expired. Update now or your card will be blocked: {scamurl}",
            "Your {entity} online banking has been locked after {days} failed attempts. Unlock here: {scamurl}",
            "{entity}: your KYC is incomplete and your account will be frozen in {hours} hours. Complete it now: {scamurl}",
        )))
        add(Template(S, Lang.EN, "CHAT", Entities.BANKS, Sender.SCAM_ANY, listOf(
            "This is the {entity} fraud department. A transaction of AED {amount} was attempted on your card. To cancel it, reply with the OTP we just sent you.",
            "Hello, I am calling from {entity} security. Please read me the verification code you received so we can block the suspicious transfer.",
            "Your {entity} account is under attack. Share the one-time password sent to your phone immediately so we can secure it.",
            "{entity} officer here. We are reversing a wrong debit of AED {amount}. Tell me the 6-digit code on your screen to confirm.",
            "Central Bank security team: your {entity} account was used in a suspicious transfer. Send us the OTP to stop it.",
        )))
        add(Template(S, Lang.EN, "SMS", Entities.IDENTITY, Sender.SCAM_ANY, listOf(
            "{entity}: your Emirates ID is about to be cancelled. Update your details within {hours} hours: {scamurl}",
            "{entity}: your account has been locked. Verify your identity to unlock it: {scamurl}",
            "Your Emirates ID renewal was rejected. Re-submit your documents and pay the AED {smallfee} fee: {scamurl}",
            "{entity}: a login request from a new device is pending. If this was not you, cancel it here: {scamurl}",
            "Dear resident, your Emirates ID is not linked to your mobile number. Link it within {hours} hours to avoid a fine: {scamurl}",
        )))
        add(Template(S, Lang.EN, "ANY", Entities.TELECOMS, Sender.SCAM_ANY, listOf(
            "Congratulations! Your number has won AED {prize} in the {entity} lucky draw. Send your card number and expiry date to claim.",
            "You have been selected as the winner of a {prizeItem}. Pay the AED {smallfee} delivery charge to receive it: {scamurl}",
            "{entity} anniversary giveaway: you won a voucher of AED {prize}. Claim within {hours} hours: {scamurl}",
            "WINNER! Your mobile number was chosen in the {entity} mega draw for AED {prize}. Call {foreignNumber} to claim your prize.",
            "Dear customer, your loyalty points worth AED {prize} expire today. Redeem now: {scamurl}",
        )))
        add(Template(S, Lang.EN, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "Work from home, AED {dailypay} per day, {jobTask}. No experience needed. Message HR on Telegram: {tme}",
            "Hiring now! Earn AED {dailypay} daily for {jobTask}. Limited slots. WhatsApp {foreignNumber}",
            "Part-time online job, {dailypay} AED/day, paid every evening. Contact {tme}",
            "Hi, I am Sara from a recruitment agency in Dubai. We pay AED {dailypay} per day for {jobTask} from your phone. Interested? Reply YES.",
            "Amazon-style tasks: {jobTask} and earn AED {dailypay} daily. Join our team: {tme}",
        )))
        add(Template(S, Lang.EN, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "Guaranteed {pct}% monthly profit trading {asset}. Licensed in Dubai. Minimum deposit AED {amount}. Join: {wame}",
            "Our forex signals never lose. {pct}% weekly return guaranteed, withdraw anytime. Join the VIP group: {tme}",
            "Double your money in {days} days with our {asset} platform. Government approved. Register: {scamurl}",
            "I made AED {prize} last month trading {asset} with this mentor. Zero risk, {pct}% guaranteed. DM me or join {tme}",
            "Exclusive {asset} investment: fixed {pct}% return every month, capital protected. Start with AED {amount}: {scamurl}",
        )))
        add(Template(S, Lang.EN, "ANY", Entities.TELECOMS + Entities.BANKS, Sender.SCAM_ANY, listOf(
            "This is {entity} technical support. Your service will be disconnected. Install {remoteApp} so our engineer can fix it.",
            "Sir/Madam, we detected a virus on your phone. Download {remoteApp} from this link so we can clean it: {scamurl}",
            "{entity} support: to reverse the wrong transaction please install {remoteApp} and share the ID code with me.",
            "Your {entity} app needs an urgent security patch. Install {remoteApp} and give us the access code to complete the update.",
        )))
        add(Template(S, Lang.EN, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "Hi {parent}, this is my new number, my old phone is broken. I need AED {amount} urgently, can you transfer to this IBAN {iban}?",
            "{parent} it's me, I lost my phone. Save this number. Can you send {amount} dirhams today? I'll explain later.",
            "Hey, I changed my number. I'm stuck and need {amount} AED for the hospital bill, please transfer now.",
            "{parent}, my phone fell in water so I'm using a friend's number. Please send AED {amount} to {iban} before 5 PM, urgent.",
            "Hi {parent} it's your son, new number. Can't talk now. Transfer AED {amount} to this account please, I'll pay you back tomorrow.",
        )))
        add(Template(S, Lang.EN, "ANY", Entities.BANKS + Entities.COURIERS, Sender.SCAM_ANY, listOf(
            "Your refund of AED {amount} from {entity} is ready. To receive it, contact our agent on WhatsApp: {wame}",
            "We have an urgent update about your {entity} account. Chat with our officer on Telegram: {tme}",
            "Your job application was approved. Continue the interview on WhatsApp {foreignNumber}.",
            "{entity}: your complaint is being handled by our senior agent. Continue on WhatsApp for a faster response: {wame}",
            "Your {entity} delivery needs confirmation. Message our courier on Telegram to arrange a time: {tme}",
        )))
        add(Template(S, Lang.EN, "SMS", Entities.UTILITIES + Entities.TOLLS, Sender.SCAM_ANY, listOf(
            "{entity}: your bill is overdue and service will be disconnected today. Pay immediately: {scamurl}",
            "{entity}: your balance is low and your tag will be suspended. Recharge now: {scamurl}",
            "{entity}: final warning, AED {amount} outstanding. Disconnection scheduled in {hours} hours. Pay here: {scamurl}",
            "{entity} notice: your account has an unpaid amount of AED {amount}. Avoid a {penalty} by paying now: {scamurl}",
        )))

        // --- Arabic ---
        add(Template(S, Lang.AR, "SMS", Entities.COURIERS, Sender.SCAM_ANY, listOf(
            "{entity}: شحنتك {tracking} محتجزة في الجمارك. ادفع {smallfee} درهم خلال {hours} ساعة وإلا سيتم إرجاعها: {scamurl}",
            "لم نتمكن من توصيل طردك بسبب رسوم جمركية غير مدفوعة بقيمة {smallfee} درهم. أكّد عنوانك وادفع عبر الرابط: {scamurl}",
            "{entity}: طردك في انتظار التسليم. يرجى تحديث عنوانك ودفع رسوم إعادة التوصيل {smallfee} درهم: {scamurl}",
            "تعذّر تسليم الشحنة {tracking} بسبب نقص في بيانات العنوان. أعد الجدولة وادفع {smallfee} درهم: {scamurl}",
        )))
        add(Template(S, Lang.AR, "SMS", Entities.POLICE, Sender.SCAM_ANY, listOf(
            "{entity}: لديك مخالفة {fineType} غير مدفوعة بقيمة {fine} درهم. ادفع خلال {hours} ساعة لتجنب {penalty}: {scamurl}",
            "إشعار أخير من {entity}. غرامتك المرورية بقيمة {fine} درهم متأخرة وسيتم حجب رخصتك. سدد الآن: {scamurl}",
            "تذكير من {entity}: مخالفة {fineType} بقيمة {fine} درهم مسجلة على مركبتك. ادفع اليوم لتجنب {penalty}: {scamurl}",
            "مواقف: مخالفة وقوف غير مدفوعة بقيمة {fine} درهم. سيتم حجز المركبة إذا لم تدفع اليوم: {scamurl}",
            "هيئة الطرق والمواصلات: مخالفة {fineType} بقيمة {fine} درهم لم تُدفع. الفرصة الأخيرة قبل {penalty}: {scamurl}",
        )))
        add(Template(S, Lang.AR, "SMS", Entities.BANKS, Sender.SCAM_ANY, listOf(
            "{entity}: تم تعليق بطاقتك بسبب نشاط غير معتاد. حدّث بياناتك خلال {hours} ساعة لاستعادة الخدمة: {scamurl}",
            "عزيزي عميل {entity}، سيتم إيقاف حسابك اليوم. حدّث معلوماتك للإبقاء على حسابك نشطاً: {scamurl}",
            "تنبيه من {entity}: انتهت صلاحية الهوية الإماراتية المرتبطة بحسابك. حدّثها الآن وإلا سيتم حظر بطاقتك: {scamurl}",
            "تم قفل خدمة {entity} أون لاين بعد {days} محاولات فاشلة. لفك القفل اضغط هنا: {scamurl}",
            "{entity}: بيانات اعرف عميلك غير مكتملة وسيتم تجميد حسابك خلال {hours} ساعة. أكملها الآن: {scamurl}",
        )))
        add(Template(S, Lang.AR, "CHAT", Entities.BANKS, Sender.SCAM_ANY, listOf(
            "نحن من قسم مكافحة الاحتيال في {entity}. تم رصد عملية بقيمة {amount} درهم على بطاقتك. لإلغائها أرسل رمز التحقق الذي وصلك الآن.",
            "معك موظف الأمان من {entity}. اقرأ لي رمز التحقق الذي استلمته حتى نوقف التحويل المشبوه.",
            "حسابك في {entity} معرّض للخطر. شارك رمز المرور لمرة واحدة فوراً لتأمينه.",
            "موظف {entity} معك. نقوم بإرجاع خصم خاطئ بقيمة {amount} درهم. أعطني الرمز المكوّن من 6 أرقام الظاهر على شاشتك للتأكيد.",
            "فريق أمن المصرف المركزي: تم استخدام حسابك في {entity} في تحويل مشبوه. أرسل لنا رمز التحقق لإيقافه.",
        )))
        add(Template(S, Lang.AR, "SMS", Entities.IDENTITY, Sender.SCAM_ANY, listOf(
            "{entity}: سيتم إلغاء هويتك الإماراتية. حدّث بياناتك خلال {hours} ساعة: {scamurl}",
            "{entity}: تم قفل حسابك. أكّد هويتك لفك الحظر: {scamurl}",
            "تم رفض طلب تجديد هويتك الإماراتية. أعد إرسال المستندات وادفع رسوم {smallfee} درهم: {scamurl}",
            "{entity}: هناك طلب تسجيل دخول من جهاز جديد قيد الانتظار. إذا لم تكن أنت، ألغِه من هنا: {scamurl}",
            "عزيزي المقيم، هويتك الإماراتية غير مرتبطة برقم هاتفك. اربطها خلال {hours} ساعة لتجنب الغرامة: {scamurl}",
        )))
        add(Template(S, Lang.AR, "ANY", Entities.TELECOMS, Sender.SCAM_ANY, listOf(
            "مبروك! رقمك فاز بـ {prize} درهم في سحب {entity}. أرسل رقم بطاقتك وتاريخ الانتهاء لاستلام الجائزة.",
            "تم اختيارك للفوز بـ {prizeItem}. ادفع رسوم التوصيل {smallfee} درهم لاستلامها: {scamurl}",
            "هدية بمناسبة ذكرى تأسيس {entity}: ربحت قسيمة بقيمة {prize} درهم. استلمها خلال {hours} ساعة: {scamurl}",
            "فائز! تم اختيار رقمك في السحب الكبير من {entity} على {prize} درهم. اتصل على {foreignNumber} لاستلام جائزتك.",
            "عزيزي العميل، نقاط الولاء الخاصة بك بقيمة {prize} درهم تنتهي اليوم. استبدلها الآن: {scamurl}",
        )))
        add(Template(S, Lang.AR, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "عمل من المنزل، {dailypay} درهم يومياً، {jobTask}. لا تحتاج خبرة. تواصل مع الموارد البشرية على تيليجرام: {tme}",
            "مطلوب موظفين فوراً! اربح {dailypay} درهم يومياً مقابل {jobTask}. الأماكن محدودة. واتساب {foreignNumber}",
            "وظيفة جزئية عبر الإنترنت، {dailypay} درهم في اليوم، الدفع كل مساء. تواصل {tme}",
            "مرحباً، أنا سارة من وكالة توظيف في دبي. ندفع {dailypay} درهم يومياً مقابل {jobTask} من هاتفك. مهتم؟ أرسل نعم.",
            "مهام بسيطة: {jobTask} واربح {dailypay} درهم يومياً. انضم لفريقنا: {tme}",
        )))
        add(Template(S, Lang.AR, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "أرباح مضمونة {pct}% شهرياً من تداول {asset}. مرخص في دبي. الحد الأدنى {amount} درهم. انضم: {wame}",
            "توصياتنا لا تخسر أبداً. عائد {pct}% أسبوعياً مضمون، اسحب أرباحك في أي وقت. انضم لمجموعة VIP: {tme}",
            "ضاعف أموالك خلال {days} أيام مع منصة {asset}. معتمدة حكومياً. سجّل الآن: {scamurl}",
            "ربحت {prize} درهم الشهر الماضي من تداول {asset} مع هذا المدرب. بدون مخاطر، {pct}% مضمونة. راسلني أو انضم {tme}",
            "استثمار حصري في {asset}: عائد ثابت {pct}% كل شهر ورأس المال محمي. ابدأ بـ {amount} درهم: {scamurl}",
        )))
        add(Template(S, Lang.AR, "ANY", Entities.TELECOMS + Entities.BANKS, Sender.SCAM_ANY, listOf(
            "معك الدعم الفني من {entity}. سيتم فصل خدمتك. حمّل تطبيق {remoteApp} ليتمكن المهندس من إصلاحها.",
            "تم اكتشاف فيروس في هاتفك. نزّل {remoteApp} من هذا الرابط لنقوم بتنظيفه: {scamurl}",
            "دعم {entity}: لإلغاء العملية الخاطئة الرجاء تحميل {remoteApp} ومشاركة رمز الجهاز معي.",
            "تطبيق {entity} يحتاج تحديثاً أمنياً عاجلاً. ثبّت {remoteApp} وأعطنا رمز الوصول لإكمال التحديث.",
        )))
        add(Template(S, Lang.AR, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "{parent}، هذا رقمي الجديد، هاتفي القديم خربان. أحتاج {amount} درهم بشكل عاجل، ممكن تحوّل على هذا الآيبان {iban}؟",
            "{parent} أنا، ضيّعت هاتفي. احفظ هذا الرقم. ممكن ترسل {amount} درهم اليوم؟ بشرح لك بعدين.",
            "غيّرت رقمي. أنا متعلق وأحتاج {amount} درهم لفاتورة المستشفى، حوّل الآن لو سمحت.",
            "{parent}، هاتفي وقع في الماء وأستخدم رقم صديقي. أرسل {amount} درهم على {iban} قبل الساعة 5، ضروري.",
            "{parent} أنا ولدك، رقم جديد. ما أقدر أتكلم الحين. حوّل {amount} درهم على هذا الحساب لو سمحت وبرجّعها بكرة.",
        )))
        add(Template(S, Lang.AR, "ANY", Entities.BANKS + Entities.COURIERS, Sender.SCAM_ANY, listOf(
            "استرداد مبلغ {amount} درهم من {entity} جاهز لك. لاستلامه تواصل مع موظفنا على واتساب: {wame}",
            "لدينا تحديث عاجل بخصوص حسابك في {entity}. تحدث مع الموظف على تيليجرام: {tme}",
            "تمت الموافقة على طلب التوظيف. أكمل المقابلة على واتساب {foreignNumber}.",
            "{entity}: شكواك قيد المعالجة لدى موظف أول. تابع على واتساب للرد الأسرع: {wame}",
            "شحنتك من {entity} تحتاج تأكيداً. راسل المندوب على تيليجرام لتحديد الوقت: {tme}",
        )))
        add(Template(S, Lang.AR, "SMS", Entities.UTILITIES + Entities.TOLLS, Sender.SCAM_ANY, listOf(
            "{entity}: فاتورتك متأخرة وسيتم قطع الخدمة اليوم. سدد فوراً عبر الرابط {scamurl}",
            "{entity}: رصيدك منخفض وسيتم تعليق البطاقة. أعد الشحن الآن: {scamurl}",
            "{entity}: تحذير أخير، مبلغ {amount} درهم مستحق. سيتم قطع الخدمة خلال {hours} ساعة. ادفع هنا: {scamurl}",
            "إشعار من {entity}: على حسابك مبلغ غير مدفوع {amount} درهم. تجنب {penalty} بالدفع الآن: {scamurl}",
        )))

        // --- Arabic in Latin letters ---
        add(Template(S, Lang.AR_LATN, "SMS", Entities.COURIERS, Sender.SCAM_ANY, listOf(
            "ya akhi el parcel mawjood 3ind el customs, edfa3 {smallfee} dirham khilal {hours} sa3a wala yerja3: {scamurl}",
            "{entity}: el tard taba3ak ma7jooz. lazem tedfa3 rosoom {smallfee} dirham 3ashan yetwassal: {scamurl}",
            "ma 2derna nwassel el shi7na {tracking}. 7adeth el 3enwan w edfa3 {smallfee} dirham men hon: {scamurl}",
            "{entity}: fi rosoom customs {smallfee} dirham 3ala el parcel taba3ak. edfa3 el yom wala yerja3 lel mursil: {scamurl}",
        )))
        add(Template(S, Lang.AR_LATN, "SMS", Entities.POLICE, Sender.SCAM_ANY, listOf(
            "{entity}: 3endak mokhalafa {fineType} ma madfoo3a {fine} dirham. edfa3 khilal {hours} sa3a 3ashan ma tseer {penalty}: {scamurl}",
            "akher tanbeeh men {entity}: el gharama taba3atak {fine} dirham mota2akhera w ra7 yet7ajez el license. seddid hala2: {scamurl}",
            "mawaqif: mokhalafat wo2oof {fine} dirham ma madfoo3a. el sayara ra7 tet7ajez eza ma dafa3t el yom: {scamurl}",
            "RTA: 3endak gharama {fineType} {fine} dirham. akher forsa abl {penalty}: {scamurl}",
        )))
        add(Template(S, Lang.AR_LATN, "SMS", Entities.BANKS, Sender.SCAM_ANY, listOf(
            "{entity}: el card taba3ak met3alla2 bsabab 7araka ghareeba. 7adeth bayanatak khilal {hours} sa3a wala ra7 yen2afel: {scamurl}",
            "3azizi 3ameel {entity}, 7esabak ra7 yetwa22af el yom. 7adeth ma3loomatak men hon: {scamurl}",
            "{entity}: el Emirates ID el marboota bi 7esabak khalset. 7adethha hala2 wala el card ra7 yet7ajeb: {scamurl}",
            "{entity}: el KYC taba3ak mesh kamel w el 7esab ra7 yetjammad khilal {hours} sa3a. kammelo hon: {scamurl}",
        )))
        add(Template(S, Lang.AR_LATN, "CHAT", Entities.BANKS, Sender.SCAM_ANY, listOf(
            "ma3ak mowazzaf el aman men {entity}. fi 7araka mashbooha bi {amount} dirham 3ala el card. 2oul li el code elli wasalak 3ashan nwa22efha.",
            "7esabak fi {entity} fi khatar, shareek el OTP elli wasalak hala2 3ashan n2affel el 7awala.",
            "ana men 2esm el e7tiyal fi {entity}. 3ashan nerja3 el khasm el ghalat {amount} dirham, 3teeni el ramz elli 3ala shashtak.",
            "el bank el markazi: 7esabak fi {entity} enesta3mal fi ta7weel mashbooh. ersel lna el OTP 3ashan nwa22efo.",
        )))
        add(Template(S, Lang.AR_LATN, "SMS", Entities.IDENTITY, Sender.SCAM_ANY, listOf(
            "{entity}: el Emirates ID taba3ak ra7 yetlagha. 7adeth bayanatak khilal {hours} sa3a: {scamurl}",
            "{entity}: 7esabak ma2fool. akked howiyatak men hon 3ashan yenfata7: {scamurl}",
            "talab tajdeed el howiya enrafad. ersel el mostanadat marra tanya w edfa3 {smallfee} dirham: {scamurl}",
            "{entity}: fi talab login men jihaz jdeed. eza mesh enta, elghih men hon: {scamurl}",
        )))
        add(Template(S, Lang.AR_LATN, "ANY", Entities.TELECOMS, Sender.SCAM_ANY, listOf(
            "mabrook! ra9mak rebe7 {prize} dirham fi sa7b {entity}. ersel ra9m el card w tareekh el entiha 3ashan testelem el jayza.",
            "enta el fayez bi {prizeItem}! edfa3 rosoom el tawseel {smallfee} dirham w testelemha: {scamurl}",
            "hadiya men {entity}: rbe7t voucher {prize} dirham. estelmo khilal {hours} sa3a: {scamurl}",
            "fayez! ra9mak enkhtar fi el sa7b el kbeer men {entity} 3ala {prize} dirham. ettasel 3ala {foreignNumber}.",
        )))
        add(Template(S, Lang.AR_LATN, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "shoghol men el bait, {dailypay} dirham bel yom, {jobTask}. ma te7taj khebra. kallem HR 3ala Telegram: {tme}",
            "wazeefa online, {dailypay} AED yawmi, el daf3 kol masa. tawasal {tme}",
            "matloob mowazzafeen! erba7 {dailypay} dirham yawmi mo2abel {jobTask}. el amaken ma7dooda. WhatsApp {foreignNumber}",
            "hala, ana Sara men sharikat tawzeef fi Dubai. nedfa3 {dailypay} dirham bel yom 3ala {jobTask} men telephonak. mohtam? ektob na3am.",
        )))
        add(Template(S, Lang.AR_LATN, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "arba7 madmoona {pct}% shahri men tadawol {asset}. morakhas fi Dubai. el 7ad el adna {amount} dirham. enzam: {wame}",
            "da3ef masarik fi {days} ayam ma3 mansat {asset}. mo3tamada 7okoomiyan. sajjel: {scamurl}",
            "tawsiyatna ma tekhsar abadan. {pct}% kol esboo3 madmoon, es7ab wa2t ma tebgha. enzam lel VIP group: {tme}",
            "rbe7t {prize} dirham el shahr elli fat men {asset} ma3 hal coach. bidoon khatar, {pct}% madmoona. kallemni aw enzam {tme}",
        )))
        add(Template(S, Lang.AR_LATN, "ANY", Entities.TELECOMS + Entities.BANKS, Sender.SCAM_ANY, listOf(
            "ma3ak el support men {entity}. el khedma ra7 tenfasel. nazzel {remoteApp} 3ashan el mohandes ysalle7 el moshkela.",
            "fi virus 3ala telephonak. 7ammel {remoteApp} men hon 3ashan nnazfo: {scamurl}",
            "da3m {entity}: 3ashan nerja3 el 3amaliya el ghalat, nazzel {remoteApp} w 3teeni el code taba3 el jihaz.",
        )))
        add(Template(S, Lang.AR_LATN, "CHAT", emptyList(), Sender.FOREIGN_NUMBER, listOf(
            "{parent}, hatha ra9mi el jdeed, telephoni el 2adeem kharban. a7taj {amount} dirham bsor3a, momken t7awel 3ala hal IBAN {iban}?",
            "{parent} ana, daya3t telephoni. e7faz hal ra9m. momken tersel {amount} dirham el yom? bashra7 lak ba3dein.",
            "ghayart ra9mi. ana m3alla2 w a7taj {amount} dirham la fatoorat el mostashfa, 7awwel hala2 law sama7t.",
            "{parent}, telephoni wa2a3 fel may w ana mesta3mel ra9m sa7bi. ersel {amount} dirham 3ala {iban} abl el 5, daroori.",
        )))
        add(Template(S, Lang.AR_LATN, "ANY", Entities.BANKS + Entities.COURIERS, Sender.SCAM_ANY, listOf(
            "el refund taba3ak {amount} dirham men {entity} jahez. 3ashan testelmo kallem el mowazzaf 3ala WhatsApp: {wame}",
            "fi ta7deeth 3ajel 3ala 7esabak fi {entity}. kallem el mowazzaf 3ala Telegram: {tme}",
            "talab el wazeefa taba3ak etwafa2 3aleh. kammel el interview 3ala WhatsApp {foreignNumber}.",
            "{entity}: el shakwa taba3atak 3end mowazzaf awwal. kammel 3ala WhatsApp 3ashan radd asra3: {wame}",
        )))
        add(Template(S, Lang.AR_LATN, "SMS", Entities.UTILITIES + Entities.TOLLS, Sender.SCAM_ANY, listOf(
            "{entity}: el fatoora mota2akhera w el khedma ra7 ten2ate3 el yom. seddid fawran men el link {scamurl}",
            "{entity}: el raseed 2aleel w el tag ra7 yet3alla2. e3ed el sha7n hala2: {scamurl}",
            "{entity}: akher tanbeeh, {amount} dirham mosta7a22a. el 2at3 khilal {hours} sa3a. edfa3 hon: {scamurl}",
        )))
    }

    private val LEGIT_TEMPLATES: List<Template> = buildList {
        val L = LabelledMessage.LABEL_LEGIT
        // --- English ---
        add(Template(L, Lang.EN, "SMS", Entities.BANKS, Sender.ENTITY_ID, listOf(
            "{entity}: {code} is your OTP for a purchase of AED {amount} at {merchant}. Do not share this code with anyone.",
            "Your {entity} verification code is {code}. It expires in {minutes} minutes. Never share it, even with bank staff.",
            "{entity}: use {code} to confirm your online banking login. If you did not request this, call the number on the back of your card.",
            "{entity}: AED {amount} was debited from your account ending {last4} at {merchant} on {date}. Available balance AED {balance}.",
            "{entity}: a salary credit of AED {amount} has been received in your account ending {last4}.",
            "{entity}: your credit card statement is ready. Minimum due AED {amount} by {date}. View it in the {entity} app.",
            "{entity}: your new debit card has been dispatched and will arrive within {days} working days.",
            "{entity}: AED {amount} was credited to your account ending {last4} on {date}. Thank you for banking with us.",
            "{entity}: your cheque book request has been processed. Collect it from your branch after {date}.",
            "{entity}: card ending {last4} was used for AED {amount} at {merchant}. If this was not you, call us on the number on your card.",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.COURIERS, Sender.ENTITY_ID, listOf(
            "{entity}: your shipment {tracking} is out for delivery today between {window}.",
            "{entity}: your parcel {tracking} has been delivered. Thank you for choosing {entity}.",
            "{entity}: we missed you today. Your parcel {tracking} will be re-attempted tomorrow. Track at {officialUrl}",
            "{entity}: your shipment {tracking} has arrived at our {city} facility and will be delivered on {date}.",
            "{entity}: your driver is nearby. Please keep your phone reachable for the next 30 minutes.",
            "{entity}: parcel {tracking} is ready for pickup at the {city} branch. Bring your Emirates ID.",
            "{entity}: shipment {tracking} is out for delivery today. Track it at {officialUrl}",
            "{entity}: your shipment {tracking} was delivered on {date} at {time}. Track your deliveries at {officialUrl}",
            "{entity}: shipment {tracking} has left our {city} hub. Expected delivery {date}. Details at {officialUrl}",
            "{entity}: your parcel {tracking} is scheduled for delivery on {date}. No action is needed.",
        )))
        add(Template(L, Lang.EN, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "Your {shop} order {orderNo} has been shipped and will arrive on {date}.",
            "{shop}: your order {orderNo} is out for delivery. The driver will call you before arrival.",
            "{shop}: your order {orderNo} has been delivered. Rate your experience in the app.",
            "{shop}: your return for order {orderNo} was received. The refund will reach your card within {days} working days.",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.UTILITIES, Sender.ENTITY_ID, listOf(
            "{entity}: your bill for {month} is AED {amount}, due on {date}. Pay through the {entity} app or {officialUrl}",
            "{entity}: payment of AED {amount} received on {date}. Thank you.",
            "{entity}: your {month} consumption was {gb}% lower than last month. Keep it up.",
            "{entity}: scheduled maintenance in your area on {date} from {time} for about two hours. We apologise for the inconvenience.",
            "{entity}: your bill of AED {amount} is now available. Due date {date}. View details at {officialUrl}",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.TELECOMS, Sender.ENTITY_ID, listOf(
            "{entity}: your bill of AED {amount} is due on {date}. Pay in the app to avoid interruption.",
            "{entity}: you have used 80% of your data allowance. Renew your plan in the app.",
            "{entity}: your recharge of AED {amount} was successful. Your balance is AED {balance}.",
            "{entity}: your postpaid bill for {month} is AED {amount}. Payment due by {date}. More at {officialUrl}",
            "{entity}: enjoy {gb} GB extra data free this month. Activate in the app.",
            "{entity}: your data pack is now active until {date}. Thank you for choosing {entity}.",
            "{entity}: your current balance is AED {balance}, valid until {date}.",
            "{entity}: your monthly plan has been renewed. {gb} GB available until {date}.",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.TOLLS, Sender.ENTITY_ID, listOf(
            "{entity}: your account balance is AED {balance}. Recharge via the {entity} app or {officialHost} when it goes below AED 10.",
            "{entity}: your vehicle registration expires on {date}. Renew via the {entity} app or {officialHost}.",
            "{entity}: a toll of AED 4 was deducted on {date} at {time}. Balance AED {balance}.",
            "{entity}: your nol card was topped up with AED {amount}. Balance AED {balance}.",
        )))
        add(Template(L, Lang.EN, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "{clinic}: reminder, your appointment with Dr. {doctor} is on {date} at {time}. Reply 1 to confirm or 2 to reschedule.",
            "{clinic}: your lab results are ready. Please log in to the {clinic} app to view them.",
            "{clinic}: your vaccination appointment for {childName} is on {date} at {time}.",
            "{clinic}: thank you for your visit today. Your prescription is ready at the pharmacy on the ground floor.",
            "{clinic}: your dental check-up is due. Book online or call us to schedule.",
        )))
        add(Template(L, Lang.EN, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "{shop}: {pct}% off {category} this weekend. Shop in the app. Reply STOP to opt out.",
            "{shop}: Yellow Friday sale, up to {pct}% off, today only. Shop in the app.",
            "{shop}: free delivery on orders above AED 100 until {date}.",
            "{shop}: new arrivals in {category} are here. Members get an extra {pct}% off this week.",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.BANKS, Sender.ENTITY_ID, listOf(
            "{entity}: earn 2x reward points on dining this {month}. T&Cs apply.",
            "{entity}: enjoy 0% instalments on {category} purchases above AED 1,000 with your credit card until {date}.",
            "{entity}: our {city} branch will be closed on {date} for the public holiday. Digital services remain available.",
        )))
        add(Template(L, Lang.EN, "SMS", listOf(Entities.ICP), Sender.ENTITY_ID, listOf(
            "ICP: your Emirates ID is ready for collection at the {city} ICP centre. Bring your passport. More at icp.gov.ae",
            "ICP: your Emirates ID application {ref} has been approved. The card will be delivered by Emirates Post within {days} working days.",
            "ICP: your appointment at the {city} customer happiness centre is on {date} at {time}.",
            "ICP: your residency visa renewal {ref} is being processed. Expected completion in {days} working days. u.ae",
            "ICP: your Emirates ID is ready for collection at the {city} ICP centre. Please bring your passport. More at https://icp.gov.ae",
            "ICP: your Emirates ID card {ref} has been printed and handed to Emirates Post for delivery.",
            "ICP: your Emirates ID has been renewed. The digital version is available in the ICP app and UAE Pass.",
        )))
        add(Template(L, Lang.EN, "SMS", listOf(Entities.UAE_PASS), Sender.ENTITY_ID, listOf(
            "UAE Pass: your account was upgraded to verified. You can now sign documents digitally. uaepass.ae",
            "UAE Pass: you signed in on a new device on {date} at {time}. If this was not you, change your password in the app.",
            "UAE Pass: your digital signature was used to sign a document on {date} at {time}.",
        )))
        add(Template(L, Lang.EN, "SMS", listOf(Entities.TAMM), Sender.ENTITY_ID, listOf(
            "TAMM: your request {ref} has been completed. View the result at tamm.abudhabi",
            "TAMM: your request {ref} has been received. Expected processing time {days} working days.",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.POLICE, Sender.ENTITY_ID, listOf(
            "{entity}: your traffic file has no outstanding fines. Drive safely.",
            "{entity}: your request {ref} has been received and is under process.",
            "{entity}: speed limits on Sheikh Zayed Road change on {date}. Drive safely.",
            "{entity}: your lost item report {ref} has been registered. We will contact you if it is found.",
            "{entity}: your payment of AED {fine} for violation {ref} was received. Thank you.",
            "{entity}: your driving licence expires on {date}. Renew it through the {entity} app or UAE Pass.",
            "{entity}: your driving licence has been renewed. The digital copy is available in the app.",
            "{entity}: no fines are registered on your traffic file as of {date}. Thank you for driving safely.",
            "{entity}: no traffic fines are registered against your vehicle. Drive safely.",
            "{entity}: all traffic fines on your file have been settled. Thank you, and drive safely.",
            "{entity}: you can check and pay traffic fines in the official app or through UAE Pass.",
            "{entity}: no traffic fines are registered on your file. Drive safely. {officialHost}",
            "{entity}: your traffic file was checked on {date}: no fines. More services at {officialUrl}",
            "{entity}: your payment for violation {ref} was received. Receipt available at {officialUrl}",
            "{entity}: your request {ref} has been completed. Details at {officialUrl}",
        )))
        add(Template(L, Lang.EN, "SMS", Entities.PARKING, Sender.ENTITY_ID, listOf(
            "{entity}: your parking in zone {zone} expires at {time}. Extend via the Darb app.",
            "{entity}: parking paid for zone {zone} until {time}. AED 2 deducted. Balance AED {balance}.",
            "{entity}: your monthly parking permit expires on {date}. Renew in the app.",
        )))
        add(Template(L, Lang.EN, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "{school}: parents are reminded that school closes at {time} on {date} for the staff meeting.",
            "{school}: the term 2 fee invoice is available on the parent portal. Due date {date}.",
            "{school}: Grade {grade} swimming lessons start {date}. Please send swimwear with your child.",
            "{school}: tomorrow is a national dress day for Grade {grade}. School buses run as normal.",
            "{school}: parent-teacher meetings are on {date} from {time}. Book your slot on the portal.",
            "{school}: the school bus for {childName} will arrive about 10 minutes late this morning due to traffic.",
        )))
        add(Template(L, Lang.EN, "CHAT", emptyList(), Sender.PERSON, listOf(
            "Are we still on for padel at {hour}? I booked court {courtNo}.",
            "Can you pick up the kids at {hour}? I'm stuck in traffic on Sheikh Zayed Road.",
            "Landed in Abu Dhabi, see you at the gate in 20 minutes.",
            "Mum says dinner is at {hour}, don't be late habibi.",
            "Did you pay the DEWA bill? I think it's due tomorrow.",
            "Happy birthday! Hope you have a great day. Dinner on me this weekend.",
            "Send me the location of the restaurant please.",
            "Meeting moved to {hour}:30, same room. Bring the printed report.",
            "I'm at Carrefour, do we need anything for the house?",
            "Jumma prayer at the big mosque at 1, coming?",
            "Can you share {friend}'s number? I lost my contacts.",
            "The plumber is coming at {hour} tomorrow, can you be home?",
            "Good luck with the exam today, you've got this.",
            "Traffic is bad on Al Khaleej Al Arabi street, take the other road.",
            "Baba, I reached the university safely, will call you tonight.",
            "Reminder: {friend}'s wedding is on {date}, we should buy the gift this week.",
        )))
        add(Template(L, Lang.EN, "CHAT", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "Hi, this is {friend} from the gym. Your session tomorrow is at {hour} AM, see you then.",
            "Your car is ready at the garage, you can collect it any time before {hour} PM.",
            "Hello, this is the tailor. Your kandura is ready for pickup.",
            "Hi, I'm the driver from {shop}, I'm at the gate, please come down.",
            "This is Noor from the salon, confirming your appointment on {date} at {time}.",
        )))

        // --- Arabic ---
        add(Template(L, Lang.AR, "SMS", Entities.BANKS, Sender.ENTITY_ID, listOf(
            "{entity}: رمز التحقق الخاص بك هو {code} لعملية شراء بقيمة {amount} درهم من {merchant}. لا تشارك هذا الرمز مع أي شخص.",
            "رمز التحقق الخاص بك من {entity} هو {code}، صالح لمدة {minutes} دقائق. لا تشاركه مع أي أحد، حتى موظفي البنك.",
            "{entity}: استخدم الرمز {code} لتأكيد تسجيل الدخول. إذا لم تطلب ذلك، اتصل بالرقم الموجود خلف بطاقتك.",
            "{entity}: تم خصم {amount} درهم من حسابك المنتهي بـ {last4} لدى {merchant} بتاريخ {date}. الرصيد المتاح {balance} درهم.",
            "{entity}: تم إيداع راتب بقيمة {amount} درهم في حسابك المنتهي بـ {last4}.",
            "{entity}: كشف حساب بطاقتك الائتمانية جاهز. الحد الأدنى للدفع {amount} درهم قبل {date}. اطلع عليه في تطبيق {entity}.",
            "{entity}: تم إرسال بطاقتك الجديدة وستصلك خلال {days} أيام عمل.",
            "{entity}: تم إيداع {amount} درهم في حسابك المنتهي بـ {last4} بتاريخ {date}. شكراً لتعاملك معنا.",
            "{entity}: تم استخدام البطاقة المنتهية بـ {last4} بمبلغ {amount} درهم لدى {merchant}. إذا لم تكن أنت، اتصل بنا على الرقم الموجود على بطاقتك.",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.COURIERS, Sender.ENTITY_ID, listOf(
            "{entity}: شحنتك {tracking} في طريقها للتوصيل اليوم بين الساعة {window}.",
            "{entity}: تم تسليم طردك {tracking}. شكراً لاختيارك {entity}.",
            "{entity}: لم نجدك اليوم. سنعيد محاولة توصيل طردك {tracking} غداً. تتبع الشحنة عبر {officialUrl}",
            "{entity}: وصلت شحنتك {tracking} إلى مركزنا في {city} وسيتم توصيلها بتاريخ {date}.",
            "{entity}: المندوب قريب منك. يرجى إبقاء هاتفك متاحاً خلال 30 دقيقة.",
            "{entity}: طردك {tracking} جاهز للاستلام من فرع {city}. يرجى إحضار الهوية الإماراتية.",
            "{entity}: شحنتك {tracking} في طريقها للتوصيل اليوم. تتبعها عبر {officialUrl}",
            "{entity}: تم تسليم شحنتك {tracking} بتاريخ {date} الساعة {time}. تتبع شحناتك عبر {officialUrl}",
            "{entity}: غادرت الشحنة {tracking} مركزنا في {city}. التوصيل المتوقع {date}. التفاصيل عبر {officialUrl}",
            "{entity}: من المقرر توصيل طردك {tracking} بتاريخ {date}. لا يلزم اتخاذ أي إجراء.",
        )))
        add(Template(L, Lang.AR, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "تم شحن طلبك من {shop} رقم {orderNo} وسيصل بتاريخ {date}.",
            "{shop}: طلبك رقم {orderNo} في طريقه إليك. سيتصل بك المندوب قبل الوصول.",
            "{shop}: تم تسليم طلبك رقم {orderNo}. قيّم تجربتك عبر التطبيق.",
            "{shop}: تم استلام المرتجع لطلبك {orderNo}. سيُعاد المبلغ إلى بطاقتك خلال {days} أيام عمل.",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.UTILITIES, Sender.ENTITY_ID, listOf(
            "{entity}: فاتورتك لشهر {month} بقيمة {amount} درهم، تاريخ الاستحقاق {date}. يمكنك الدفع عبر التطبيق أو {officialUrl}",
            "{entity}: تم استلام دفعة بقيمة {amount} درهم بتاريخ {date}. شكراً لك.",
            "{entity}: استهلاكك لشهر {month} أقل بنسبة {gb}% من الشهر الماضي. أحسنت.",
            "{entity}: صيانة مجدولة في منطقتك بتاريخ {date} من الساعة {time} لمدة ساعتين تقريباً. نعتذر عن الإزعاج.",
            "{entity}: فاتورتك بقيمة {amount} درهم متاحة الآن. تاريخ الاستحقاق {date}.",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.TELECOMS, Sender.ENTITY_ID, listOf(
            "{entity}: فاتورتك بقيمة {amount} درهم مستحقة بتاريخ {date}. ادفع عبر التطبيق لتجنب انقطاع الخدمة.",
            "{entity}: استهلكت 80% من باقة البيانات. جدّد باقتك عبر التطبيق.",
            "{entity}: تم شحن رصيدك بمبلغ {amount} درهم بنجاح. رصيدك الحالي {balance} درهم.",
            "{entity}: فاتورة شهر {month} بقيمة {amount} درهم. الدفع قبل {date}. التفاصيل عبر {officialUrl}",
            "{entity}: استمتع بـ {gb} جيجابايت إضافية مجاناً هذا الشهر. فعّلها من التطبيق.",
            "{entity}: تم تفعيل باقة البيانات بنجاح. صالحة حتى {date}.",
            "{entity}: رصيدك الحالي {balance} درهم، صالح حتى {date}. شكراً لاستخدامك {entity}.",
            "{entity}: تم تجديد باقتك الشهرية بنجاح. {gb} جيجابايت متاحة حتى {date}.",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.TOLLS, Sender.ENTITY_ID, listOf(
            "{entity}: رصيدك الحالي {balance} درهم. أعد الشحن عبر تطبيق {entity} عندما يقل عن 10 دراهم.",
            "{entity}: تنتهي ملكية مركبتك بتاريخ {date}. جدّد عبر التطبيق أو {officialHost}.",
            "{entity}: تم خصم 4 دراهم عند المرور بتاريخ {date} الساعة {time}. الرصيد {balance} درهم.",
            "{entity}: تم شحن بطاقة نول بمبلغ {amount} درهم. الرصيد {balance} درهم.",
        )))
        add(Template(L, Lang.AR, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "{clinic}: تذكير بموعدك مع د. {doctor} بتاريخ {date} الساعة {time}. أرسل 1 للتأكيد أو 2 لإعادة الجدولة.",
            "{clinic}: نتائج التحاليل جاهزة. يمكنك الاطلاع عليها عبر التطبيق.",
            "{clinic}: موعد تطعيم {childName} بتاريخ {date} الساعة {time}.",
            "{clinic}: شكراً لزيارتك اليوم. وصفتك الطبية جاهزة في الصيدلية بالطابق الأرضي.",
            "{clinic}: حان موعد فحص الأسنان الدوري. احجز عبر الإنترنت أو اتصل بنا.",
        )))
        add(Template(L, Lang.AR, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "{shop}: خصم {pct}% على {category} نهاية هذا الأسبوع. تسوق عبر التطبيق.",
            "{shop}: تخفيضات الجمعة الصفراء، خصم يصل إلى {pct}%، اليوم فقط. تسوق عبر التطبيق.",
            "{shop}: توصيل مجاني للطلبات فوق 100 درهم حتى {date}.",
            "{shop}: وصلت تشكيلة {category} الجديدة. الأعضاء يحصلون على خصم إضافي {pct}% هذا الأسبوع.",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.BANKS, Sender.ENTITY_ID, listOf(
            "{entity}: اكسب نقاط مكافآت مضاعفة على المطاعم خلال شهر {month}. تطبق الشروط والأحكام.",
            "{entity}: استمتع بتقسيط بدون فوائد على مشتريات {category} فوق 1,000 درهم ببطاقتك الائتمانية حتى {date}.",
            "{entity}: سيكون فرع {city} مغلقاً بتاريخ {date} بمناسبة العطلة الرسمية. الخدمات الرقمية متاحة.",
        )))
        add(Template(L, Lang.AR, "SMS", listOf(Entities.ICP), Sender.ENTITY_ID, listOf(
            "الهيئة الاتحادية للهوية والجنسية: بطاقة الهوية الإماراتية جاهزة للاستلام من مركز {city}. يرجى إحضار جواز السفر. icp.gov.ae",
            "الهيئة الاتحادية للهوية والجنسية: تمت الموافقة على طلب الهوية رقم {ref}. ستصلك البطاقة عبر بريد الإمارات خلال {days} أيام عمل.",
            "الهيئة الاتحادية للهوية والجنسية: موعدك في مركز {city} بتاريخ {date} الساعة {time}.",
            "الهيئة الاتحادية للهوية والجنسية: طلب تجديد الإقامة رقم {ref} قيد المعالجة. الإنجاز المتوقع خلال {days} أيام عمل. u.ae",
            "الهيئة الاتحادية للهوية والجنسية: بطاقة الهوية الإماراتية جاهزة للاستلام من مركز {city}. يرجى إحضار جواز السفر. المزيد عبر https://icp.gov.ae",
            "الهيئة الاتحادية للهوية والجنسية: تمت طباعة بطاقة الهوية رقم {ref} وتسليمها لبريد الإمارات للتوصيل.",
            "الهيئة الاتحادية للهوية والجنسية: تم تجديد هويتك الإماراتية. النسخة الرقمية متاحة في التطبيق والهوية الرقمية.",
        )))
        add(Template(L, Lang.AR, "SMS", listOf(Entities.UAE_PASS), Sender.ENTITY_ID, listOf(
            "الهوية الرقمية: تم ترقية حسابك إلى حساب موثّق. يمكنك الآن توقيع المستندات رقمياً. uaepass.ae",
            "الهوية الرقمية: تم تسجيل الدخول من جهاز جديد بتاريخ {date} الساعة {time}. إذا لم تكن أنت، غيّر كلمة المرور من التطبيق.",
            "الهوية الرقمية: تم استخدام توقيعك الرقمي لتوقيع مستند بتاريخ {date} الساعة {time}.",
        )))
        add(Template(L, Lang.AR, "SMS", listOf(Entities.TAMM), Sender.ENTITY_ID, listOf(
            "تم: تم إنجاز طلبك رقم {ref}. يمكنك الاطلاع على النتيجة عبر tamm.abudhabi",
            "تم: تم استلام طلبك رقم {ref}. مدة المعالجة المتوقعة {days} أيام عمل.",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.POLICE, Sender.ENTITY_ID, listOf(
            "{entity}: لا توجد مخالفات مرورية على ملفك. قيادة آمنة.",
            "{entity}: تم استلام طلبك رقم {ref} وهو قيد المعالجة.",
            "{entity}: تتغير حدود السرعة على شارع الشيخ زايد اعتباراً من {date}. قيادة آمنة.",
            "{entity}: تم تسجيل بلاغ المفقودات رقم {ref}. سنتواصل معك عند العثور عليه.",
            "{entity}: تم استلام دفعتك بقيمة {fine} درهم للمخالفة رقم {ref}. شكراً لك.",
            "{entity}: تنتهي صلاحية رخصة القيادة بتاريخ {date}. جدّدها عبر التطبيق أو الهوية الرقمية.",
            "{entity}: تم تجديد رخصة القيادة بنجاح. يمكنك تحميل النسخة الرقمية من التطبيق.",
            "{entity}: لا توجد مخالفات مسجلة على ملفك المروري حتى تاريخ {date}. نتمنى لك قيادة آمنة.",
            "{entity}: لا توجد مخالفات مرورية مسجلة على مركبتك. نتمنى لك قيادة آمنة.",
            "{entity}: تم سداد جميع المخالفات المرورية المسجلة على ملفك. شكراً لك ونتمنى لك قيادة آمنة.",
            "{entity}: يمكنك الاستعلام عن المخالفات المرورية وسدادها عبر التطبيق الرسمي أو الهوية الرقمية.",
            "{entity}: نتيجة الاستعلام: لا توجد مخالفات مرورية على رقم اللوحة المسجل باسمك.",
            "{entity}: لا توجد مخالفات مرورية مسجلة على ملفك. نتمنى لك قيادة آمنة. {officialHost}",
            "{entity}: تم فحص ملفك المروري بتاريخ {date}: لا توجد مخالفات. المزيد من الخدمات عبر {officialUrl}",
            "{entity}: تم استلام دفعتك للمخالفة رقم {ref}. الإيصال متاح عبر {officialUrl}",
            "{entity}: تم إنجاز طلبك رقم {ref}. التفاصيل عبر {officialUrl}",
        )))
        add(Template(L, Lang.AR, "SMS", Entities.PARKING, Sender.ENTITY_ID, listOf(
            "{entity}: ينتهي وقت المواقف في المنطقة {zone} الساعة {time}. يمكنك التمديد عبر تطبيق درب.",
            "{entity}: تم دفع رسوم المواقف للمنطقة {zone} حتى الساعة {time}. تم خصم درهمين. الرصيد {balance} درهم.",
            "{entity}: ينتهي تصريح المواقف الشهري بتاريخ {date}. جدّده عبر التطبيق.",
        )))
        add(Template(L, Lang.AR, "SMS", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "{school}: نذكّر أولياء الأمور بأن الدوام ينتهي الساعة {time} يوم {date} بسبب اجتماع الهيئة التدريسية.",
            "{school}: فاتورة الفصل الثاني متاحة على بوابة أولياء الأمور. تاريخ الاستحقاق {date}.",
            "{school}: تبدأ دروس السباحة للصف {grade} بتاريخ {date}. يرجى إرسال ملابس السباحة مع الطالب.",
            "{school}: غداً يوم الزي الوطني للصف {grade}. الحافلات تعمل كالمعتاد.",
            "{school}: اجتماع أولياء الأمور بتاريخ {date} من الساعة {time}. احجز موعدك عبر البوابة.",
            "{school}: ستتأخر حافلة {childName} حوالي 10 دقائق هذا الصباح بسبب الازدحام.",
        )))
        add(Template(L, Lang.AR, "CHAT", emptyList(), Sender.PERSON, listOf(
            "السلام عليكم، الاجتماع بكرة الساعة {hour} الصبح في المكتب.",
            "ممكن تاخذ الأولاد من المدرسة الساعة {hour}؟ أنا واقف في الزحمة.",
            "وصلت المطار، أشوفك عند البوابة بعد 20 دقيقة.",
            "ماما تقول العشا الساعة {hour}، لا تتأخر.",
            "دفعت فاتورة الكهرباء؟ أعتقد آخر يوم بكرة.",
            "كل عام وأنت بخير! العشا عليّ نهاية الأسبوع.",
            "أرسل لي لوكيشن المطعم لو سمحت.",
            "تأجل الاجتماع للساعة {hour} ونص، نفس القاعة. جيب التقرير المطبوع.",
            "أنا في كارفور، نحتاج شي للبيت؟",
            "صلاة الجمعة في المسجد الكبير الساعة 1، جاي؟",
            "ممكن ترسل لي رقم {friend}؟ ضاعت جهات الاتصال عندي.",
            "السباك جاي بكرة الساعة {hour}، تقدر تكون في البيت؟",
            "بالتوفيق في الامتحان اليوم، إن شاء الله تنجح.",
            "الطريق زحمة على شارع الخليج العربي، خذ الطريق الثاني.",
            "يبه، وصلت الجامعة بالسلامة، بتصل عليك الليل.",
            "تذكير: عرس {friend} بتاريخ {date}، لازم نشتري الهدية هالأسبوع.",
        )))
        add(Template(L, Lang.AR, "CHAT", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "مرحباً، معك {friend} من النادي. حصتك بكرة الساعة {hour} الصبح، أشوفك.",
            "سيارتك جاهزة في الكراج، تقدر تاخذها أي وقت قبل الساعة {hour} المسا.",
            "السلام عليكم، معك الخياط. الكندورة جاهزة للاستلام.",
            "مرحبا، أنا المندوب من {shop}، واقف عند البوابة، لو سمحت انزل.",
            "معك نور من الصالون، نأكد موعدك بتاريخ {date} الساعة {time}.",
        )))

        // --- Arabic in Latin letters (chat and small businesses) ---
        add(Template(L, Lang.AR_LATN, "CHAT", emptyList(), Sender.PERSON, listOf(
            "yalla nel2a 3al {hour} fel padel? 7ajazt el court {courtNo}.",
            "momken takhod el awlad men el madrasa el sa3a {hour}? ana wa2ef fel za7ma.",
            "weselt el matar, ashoofak 3end el gate ba3d 20 d2ee2a.",
            "mama t2ool el 3asha el sa3a {hour}, la tet2akhar.",
            "dafa3t fatoorat el kahraba? a3ta2ed akher yom bokra.",
            "kol sana w enta tayeb! el 3asha 3alay el weekend.",
            "ersel li location el mat3am law sama7t.",
            "el ejtima3 bokra el sa3a {hour} el sob7 fel maktab, la tensa el laptop.",
            "wesalt el bait bel salama, tasbe7 3ala kheir.",
            "sho ra2yak nroo7 el mall ba3d el 3asha?",
            "ana fel Carrefour, ne7taj shi lel bait?",
            "salat el jom3a fel masjed el kbeer el sa3a 1, jay?",
            "momken tersel li ra9m {friend}? da3et el contacts 3endi.",
            "el sabbak jay bokra el sa3a {hour}, te2dar tkoon fel bait?",
            "bel tawfee2 fel emte7an el yom, enta 2adha.",
            "el taree2 za7ma 3ala share3 el khaleej el 3arabi, khod el taree2 el tani.",
            "yuba, weselt el jam3a bel salama, batasel 3alek el lail.",
            "tazkeer: 3ers {friend} yom {date}, lazem neshtiri el hadiya hal esboo3.",
            "ta2ajjal el ejtima3 lel sa3a {hour} w nos, nafs el 2a3a. jeeb el ta2reer.",
            "7abibi, jeeb khobz w 7aleeb w enta jay.",
            "ba3d el dawam nroo7 el corniche? el jaw 7elo el yom.",
            "shokran 3ala el ghada el yom, kan ktheer tayeb.",
        )))
        add(Template(L, Lang.AR_LATN, "ANY", emptyList(), Sender.LOCAL_NUMBER, listOf(
            "hala, ana {friend} men el gym. el session bokra el sa3a {hour} el sob7, ashoofak.",
            "el sayara jahza fel garage, te2dar takhodha ay wa2t abl el {hour} el masa.",
            "salam, ma3ak el khayat. el kandoora jahza, momken temor takhodha.",
            "marhaba, ana el mandoob men {shop}, wa2ef 3end el gate, law sama7t enzel.",
            "ma3ak Noor men el salon, n2akked maw3edak yom {date} el sa3a {time}.",
            "el order taba3ak jahez, momken temor takhdo ba3d el {hour}.",
            "el mo3allem {friend}: el dars bokra el sa3a {hour}, la tensa el kitab.",
            "ma3ak el kahraba2i, bajeek ba3d {hour} daqayeq, el bab maftoo7?",
        )))
    }

    companion object {
        const val DEFAULT_SEED = 42
        private val SLOT_PATTERN = Regex("""\{(\w+)\}""")
        private val FOREIGN_CODES = listOf("+44", "+92", "+63", "+91", "+1", "+234", "+20", "+62")
        private val SCAM_SLUGS = listOf(
            "emiratespost", "aramex", "adcb", "fab", "adib", "emiratesnbd", "mashreq", "dewa", "addc", "salik", "rta",
            "mawaqif", "uaepass", "icp", "tamm", "adpolice", "dubaipolice", "etisalat", "du", "uae-gov",
        )
        private val SCAM_WORDS = listOf(
            "verify", "secure", "update", "pay", "fee", "fines", "kyc", "refund", "track", "delivery", "customs", "login",
            "unlock", "renew", "claim", "support",
        )
        private val SCAM_PATHS = listOf("pay", "login", "verify", "confirm", "update", "claim", "track", "ae", "")
        private val PERSONS_EN = listOf("Khalid", "Fatima", "Mum", "Dad", "Ahmed", "Sara", "Omar", "Noora", "Mariam", "Abu Omar", "Um Khalid", "Hamad", "Reem")
        private val PERSONS_AR = listOf("أبو عمر", "أم خالد", "ماما", "بابا", "خالد", "فاطمة", "سارة", "أحمد", "نورة", "حمد", "ريم", "مريم")
        private val PERSONS_LATN = listOf("Khalid", "Mama", "Baba", "Abu Omar", "Noora", "Hamad", "Reem", "Sara", "Um Khalid", "Ahmed")
    }
}
