package house.rabbithole.nasa

import org.json.JSONObject
import java.time.Instant

data class SourceDecision(val url: String, val kind: String)

/** Reads the same canonical validation receipt as Windows. No provider URL construction or guessing. */
object SourceDecisions {
    fun get(raw: String, id: String, hash: String, now: Instant = Instant.now()): SourceDecision? = try {
        val root = JSONObject(raw)
        if (root.optInt("version") != 1) null else {
            val row = root.getJSONObject("records").getJSONObject(id)
            val chosen = row.getJSONObject("selected")
            val url = Catalog.nasaUrl(chosen.optString("url"))
            val checks = row.getJSONArray("checks")
            val evidence = (0 until checks.length()).map { checks.getJSONObject(it) }
            if (url == null || row.optString("id") != id || row.optString("presentationSha256") != hash ||
                row.optString("state") != "valid" || chosen.optInt("status") !in 200..299 ||
                Instant.parse(row.getString("validUntil")) <= now ||
                evidence.none { it.optString("state") == "valid" && it.optString("finalUrl") == url } ||
                evidence.any { it.optString("state") == "missing" && (it.optString("url") == url || it.optString("finalUrl") == url) }) null
            else SourceDecision(url, chosen.optString("kind"))
        }
    } catch (_: Exception) { null }
}
