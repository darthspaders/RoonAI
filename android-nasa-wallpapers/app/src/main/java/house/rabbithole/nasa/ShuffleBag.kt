package house.rabbithole.nasa

import org.json.JSONArray
import org.json.JSONObject
import kotlin.random.Random

/** Persist only rotation history, not another metadata database. Selection is committed after setBitmap succeeds. */
class ShuffleBag(private val seen: MutableSet<String> = linkedSetOf(), var last: String? = null) {
    fun candidates(available: List<String>, random: Random = Random.Default): List<String> {
        val all = available.distinct()
        val unseen = all.filter { it !in seen && (it != last || all.size == 1) }
        if (unseen.isNotEmpty()) return unseen.shuffled(random)
        return all.filter { it != last || all.size == 1 }.shuffled(random)
    }
    fun markShown(name: String, available: List<String>) {
        val existing = available.toSet()
        seen.retainAll(existing)
        if (existing.isNotEmpty() && existing.all { it in seen }) seen.clear()
        seen.add(name)
        last = name
    }
    fun json(): String = JSONObject().put("seen", JSONArray(seen.toList())).put("last", last).toString()
    companion object {
        fun fromJson(raw: String): ShuffleBag = try {
            val row = JSONObject(raw)
            val entries = row.optJSONArray("seen") ?: JSONArray()
            val seen = (0 until minOf(entries.length(), 20000)).map { entries.optString(it) }.filter { Catalog.validFilename(it) }.toMutableSet()
            ShuffleBag(seen, row.optString("last").takeIf { Catalog.validFilename(it) })
        } catch (_: Exception) { ShuffleBag() }
    }
}
