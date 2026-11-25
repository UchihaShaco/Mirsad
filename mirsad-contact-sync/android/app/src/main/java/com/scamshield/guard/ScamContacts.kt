package com.scamshield.guard

import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Note
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.RawContacts
import android.util.Log

/**
 * Makes the device's address book match the server's scammer list.
 *
 * All flagged numbers live as phone entries on ONE contact ("⚠️ Known Scammer").
 * When that contact is full (MAX_PER_CONTACT numbers) overflow goes to
 * "⚠️ Known Scammer 2", "… 3", etc.
 *
 * Our contacts are found again via a hidden marker data row (custom mimetype), which every
 * OEM contacts provider (incl. Samsung) preserves – so we never touch the user's own contacts.
 *
 * [sync] is a full, idempotent reconcile: it is always safe to call again.
 */
object ScamContacts {
    private const val TAG = "ScamContacts"

    /** Hidden data row that tags a raw contact as ours. DATA1 = chunk index (1, 2, 3…). */
    const val MARKER_MIME = "vnd.android.cursor.item/vnd.com.scamshield.guard.marker"

    /** Numbers per contact before spilling into "Known Scammer 2". Kept modest so contact UIs stay snappy. */
    const val MAX_PER_CONTACT = 50

    const val DEFAULT_NAME = "⚠️ Known Scammer"
    private const val NOTE = "Numbers flagged as scammers by Mirsad. Do NOT send money, codes or personal details."

    data class Result(val added: Int, val removed: Int, val total: Int, val contacts: Int)

    private class Chunk(val rawId: Long, val index: Int) {
        var nameDataId: Long = -1
        var name: String? = null
        val phones = mutableListOf<Pair<Long, String>>() // dataId to normalized number
        var kept = 0
    }

    /** Canonical form for comparing numbers: keep leading '+' and digits only. */
    fun normalize(n: String): String {
        val t = n.trim()
        val digits = t.filter { it.isDigit() }
        return if (t.startsWith("+")) "+$digits" else if (t.startsWith("00")) "+" + digits.drop(2) else digits
    }

    fun chunkName(base: String, index: Int) = if (index <= 1) base else "$base $index"

    @Synchronized
    fun sync(ctx: Context, numbers: List<String>, baseName: String = DEFAULT_NAME): Result {
        val cr = ctx.contentResolver
        val desired = LinkedHashSet<String>()
        numbers.map(::normalize).filter { it.length >= 5 }.forEach { desired += it }

        val chunks = loadChunks(cr)
        val ops = ArrayList<ContentProviderOperation>()
        val seen = HashSet<String>()
        var removed = 0

        // 1) Drop numbers that are no longer flagged (and duplicates).
        for (c in chunks) {
            for ((dataId, num) in c.phones) {
                if (num in desired && seen.add(num)) {
                    c.kept++
                } else {
                    ops += ContentProviderOperation.newDelete(
                        ContentUris_withAppendedId(Data.CONTENT_URI, dataId)
                    ).build()
                    removed++
                }
            }
        }

        // 2) Add new numbers into existing chunks that have room…
        val missing = ArrayDeque(desired.filter { it !in seen })
        val added = missing.size
        for (c in chunks) {
            while (c.kept < MAX_PER_CONTACT && missing.isNotEmpty()) {
                ops += insertPhone(c.rawId, missing.removeFirst())
                c.kept++
            }
        }

        // 3) Delete chunks that ended up empty (e.g. everything un-flagged) …
        val alive = chunks.filter { c ->
            if (c.kept == 0) {
                ops += ContentProviderOperation.newDelete(
                    RawContacts.CONTENT_URI.asSyncAdapter().buildUpon()
                        .appendPath(c.rawId.toString()).build()
                ).build()
                false
            } else true
        }.toMutableList()

        // 4) Renumber surviving chunks 1..n and enforce the display name.
        alive.forEachIndexed { i, c ->
            val wanted = chunkName(baseName, i + 1)
            if (c.index != i + 1) {
                ops += ContentProviderOperation.newUpdate(Data.CONTENT_URI)
                    .withSelection("${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?", arrayOf(c.rawId.toString(), MARKER_MIME))
                    .withValue(Data.DATA1, (i + 1).toString())
                    .build()
            }
            if (c.name != wanted) {
                ops += if (c.nameDataId > 0) {
                    ContentProviderOperation.newUpdate(ContentUris_withAppendedId(Data.CONTENT_URI, c.nameDataId))
                        .withValues(nameValues(wanted)).build()
                } else {
                    ContentProviderOperation.newInsert(Data.CONTENT_URI)
                        .withValue(Data.RAW_CONTACT_ID, c.rawId)
                        .withValue(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
                        .withValues(nameValues(wanted)).build()
                }
            }
        }
        flush(cr, ops)

        // 5) …and create new chunks for whatever still doesn't fit.
        var nextIndex = alive.size + 1
        while (missing.isNotEmpty()) {
            val batch = ArrayList<ContentProviderOperation>()
            val back = batch.size
            batch += ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
                .withValue(RawContacts.ACCOUNT_TYPE, null)   // device-local contact, never synced to Google
                .withValue(RawContacts.ACCOUNT_NAME, null)
                // Never merge with the user's own contact for the same number.
                .withValue(RawContacts.AGGREGATION_MODE, RawContacts.AGGREGATION_MODE_DISABLED)
                .build()
            batch += ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValueBackReference(Data.RAW_CONTACT_ID, back)
                .withValue(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
                .withValues(nameValues(chunkName(baseName, nextIndex))).build()
            batch += ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValueBackReference(Data.RAW_CONTACT_ID, back)
                .withValue(Data.MIMETYPE, MARKER_MIME)
                .withValue(Data.DATA1, nextIndex.toString()).build()
            batch += ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValueBackReference(Data.RAW_CONTACT_ID, back)
                .withValue(Data.MIMETYPE, Note.CONTENT_ITEM_TYPE)
                .withValue(Note.NOTE, NOTE).build()
            var n = 0
            while (n < MAX_PER_CONTACT && missing.isNotEmpty()) {
                batch += ContentProviderOperation.newInsert(Data.CONTENT_URI)
                    .withValueBackReference(Data.RAW_CONTACT_ID, back)
                    .withValue(Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
                    .withValue(Phone.NUMBER, missing.removeFirst())
                    .withValue(Phone.TYPE, Phone.TYPE_MOBILE).build()
                n++
            }
            cr.applyBatch(ContactsContract.AUTHORITY, batch)
            nextIndex++
        }

        val result = Result(added, removed, desired.size, nextIndex - 1)
        Log.i(TAG, "sync: $result")
        return result
    }

    /** Remove every contact this app created. */
    @Synchronized
    fun removeAll(ctx: Context): Int {
        val chunks = loadChunks(ctx.contentResolver)
        val ops = chunks.map {
            ContentProviderOperation.newDelete(
                RawContacts.CONTENT_URI.asSyncAdapter().buildUpon().appendPath(it.rawId.toString()).build()
            ).build()
        }
        flush(ctx.contentResolver, ArrayList(ops))
        return chunks.size
    }

    /** Aggregate contact id of "Known Scammer" #1, for the "open contact" button. */
    fun firstContactUri(ctx: Context): Uri? {
        val rawId = loadChunks(ctx.contentResolver).firstOrNull()?.rawId ?: return null
        ctx.contentResolver.query(
            RawContacts.CONTENT_URI, arrayOf(RawContacts.CONTACT_ID),
            "${RawContacts._ID}=?", arrayOf(rawId.toString()), null
        )?.use { c ->
            if (c.moveToFirst()) return ContentUris_withAppendedId(ContactsContract.Contacts.CONTENT_URI, c.getLong(0))
        }
        return null
    }

    // ------------------------------------------------------------------ helpers

    private fun loadChunks(cr: ContentResolver): List<Chunk> {
        val chunks = LinkedHashMap<Long, Chunk>()
        cr.query(
            Data.CONTENT_URI, arrayOf(Data.RAW_CONTACT_ID, Data.DATA1),
            "${Data.MIMETYPE}=?", arrayOf(MARKER_MIME), null
        )?.use { c ->
            while (c.moveToNext()) {
                val raw = c.getLong(0)
                chunks.getOrPut(raw) { Chunk(raw, c.getString(1)?.toIntOrNull() ?: 99) }
            }
        }
        if (chunks.isEmpty()) return emptyList()

        val ids = chunks.keys.joinToString(",")
        cr.query(
            Data.CONTENT_URI, arrayOf(Data._ID, Data.RAW_CONTACT_ID, Data.MIMETYPE, Data.DATA1),
            "${Data.RAW_CONTACT_ID} IN ($ids) AND ${Data.MIMETYPE} IN (?,?)",
            arrayOf(Phone.CONTENT_ITEM_TYPE, StructuredName.CONTENT_ITEM_TYPE), "${Data._ID} ASC"
        )?.use { c ->
            while (c.moveToNext()) {
                val chunk = chunks[c.getLong(1)] ?: continue
                when (c.getString(2)) {
                    Phone.CONTENT_ITEM_TYPE -> chunk.phones += c.getLong(0) to normalize(c.getString(3) ?: "")
                    StructuredName.CONTENT_ITEM_TYPE -> { chunk.nameDataId = c.getLong(0); chunk.name = c.getString(3) }
                }
            }
        }
        return chunks.values.sortedWith(compareBy({ it.index }, { it.rawId }))
    }

    private fun insertPhone(rawId: Long, number: String) =
        ContentProviderOperation.newInsert(Data.CONTENT_URI)
            .withValue(Data.RAW_CONTACT_ID, rawId)
            .withValue(Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
            .withValue(Phone.NUMBER, number)
            .withValue(Phone.TYPE, Phone.TYPE_MOBILE)
            .build()

    /** Whole name goes in GIVEN_NAME so no locale's name-splitting can turn it into "Scammer, ⚠️ Known". */
    private fun nameValues(name: String) = android.content.ContentValues().apply {
        put(StructuredName.DISPLAY_NAME, name)
        put(StructuredName.GIVEN_NAME, name)
        putNull(StructuredName.FAMILY_NAME)
        putNull(StructuredName.MIDDLE_NAME)
        putNull(StructuredName.PREFIX)
        putNull(StructuredName.SUFFIX)
    }

    private fun flush(cr: ContentResolver, ops: ArrayList<ContentProviderOperation>) {
        // Independent operations only (no back-references), so chunking is safe.
        ops.chunked(250).forEach { cr.applyBatch(ContactsContract.AUTHORITY, ArrayList(it)) }
        ops.clear()
    }

    private fun Uri.asSyncAdapter(): Uri =
        buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build()

    @Suppress("FunctionName")
    private fun ContentUris_withAppendedId(uri: Uri, id: Long): Uri = android.content.ContentUris.withAppendedId(uri, id)
}
