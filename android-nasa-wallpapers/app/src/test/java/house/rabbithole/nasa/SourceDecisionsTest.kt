package house.rabbithole.nasa

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class SourceDecisionsTest {
    private val id = "nasa-science-42"
    private val hash = "a".repeat(64)
    private val now = Instant.parse("2026-10-11T15:00:00Z")
    private val url = "https://assets.science.nasa.gov/actual.png"
    private fun receipt(): JSONObject {
        val row = JSONObject().put("id", id).put("presentationSha256", hash).put("state", "valid")
            .put("validUntil", "2026-10-18T15:00:00Z")
            .put("selected", JSONObject().put("url", url).put("kind", "image").put("status", 200))
            .put("checks", JSONArray().put(JSONObject().put("url", "https://science.nasa.gov/missing").put("state", "missing").put("status", 404))
                .put(JSONObject().put("url", url).put("finalUrl", url).put("state", "valid").put("status", 200)))
        return JSONObject().put("version", 1).put("records", JSONObject().put(id, row))
    }
    @Test fun usesSharedCanonicalDecisionInsteadOfRawSourceOrGuessedProviderRoute() {
        val result = SourceDecisions.get(receipt().toString(), id, hash, now)
        assertEquals(url, result?.url); assertEquals("image", result?.kind)
    }
    @Test fun absentExpiredAndMismatchedReceiptsNeverProduceALink() {
        assertNull(SourceDecisions.get("{}", id, hash, now))
        assertNull(SourceDecisions.get(receipt().toString(), id, "b".repeat(64), now))
        assertNull(SourceDecisions.get(receipt().toString(), id, hash, now.plusSeconds(8 * 86400)))
    }
    @Test fun known404AndUnsafeSelectionCannotBeOpened() {
        val root = receipt(); val row = root.getJSONObject("records").getJSONObject(id)
        row.getJSONArray("checks").put(JSONObject().put("url", url).put("state", "missing").put("status", 404))
        assertNull(SourceDecisions.get(root.toString(), id, hash, now))
        row.getJSONObject("selected").put("url", "https://nasa.gov.evil.example/a")
        assertNull(SourceDecisions.get(root.toString(), id, hash, now))
    }
}
