package house.rabbithole.nasa

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CacheTest {
    @get:Rule val temp = TemporaryFolder()
    private fun entry(bytes: ByteArray): PublishedImage { val h = sha256(bytes); return PublishedImage("NASA-$h.jpg", h, listOf("nasa-test"), bytes.size.toLong()) }
    private fun metadata(entry: PublishedImage) = JSONObject().put("id", "nasa-test").put("stage", "verified").put("title", "Test")
        .put("presentationSha256", entry.hash).put("prepared", JSONObject().put("files", JSONObject().put("background-4k.jpg", entry.hash))).toString()
    private fun manifest(entries: List<PublishedImage>): String {
        val files = JSONObject()
        entries.forEach { files.put(it.filename, JSONObject().put("sha256", it.hash).put("ids", JSONArray(it.ids)).put("bytes", it.bytes).put("width", 3840).put("height", 2160)) }
        return JSONObject().put("version", 1).put("files", files).toString()
    }
    @Test fun interruptedDownloadNeverReplacesCurrentOrExposesPartialPair() {
        val cache = ImageCache(temp.newFolder()); val bytes = "verified".toByteArray(); val current = entry(bytes)
        cache.saveManifest(manifest(listOf(current)))
        cache.install(current, metadata(current), { it.writeBytes(bytes) }, emptySet())
        val next = entry("next".toByteArray())
        assertThrows(IllegalStateException::class.java) {
            cache.install(next, metadata(next), { it.writeText("n"); error("interrupted") }, setOf(current.filename))
        }
        assertNotNull(cache.get(current)); assertNull(cache.get(next))
        assertFalse(cache.root.listFiles()!!.any { it.name.endsWith(".part") })
        assertNotNull(ImageCache(cache.root).get(current))
    }
    @Test fun wrongBytesOrMetadataCannotBecomeCachedWallpaper() {
        val cache = ImageCache(temp.newFolder()); val e = entry("good".toByteArray())
        assertThrows(UserProblem::class.java) { cache.install(e, metadata(e), { it.writeText("evil") }, emptySet()) }
        assertNull(cache.get(e))
        assertThrows(UserProblem::class.java) { cache.install(e, metadata(e).replace("verified", "prepared"), { it.writeText("good") }, emptySet()) }
    }
    @Test fun cacheIsBoundedAndRetainsCurrentDuringPrefetch() {
        val cache = ImageCache(temp.newFolder()); val entries = (0..7).map { entry("photo-$it".toByteArray()) }
        cache.saveManifest(manifest(entries))
        for ((index, entry) in entries.withIndex()) cache.install(entry, metadata(entry), { it.writeText("photo-$index") }, setOf(entries.first().filename))
        assertEquals(3, cache.cached().size)
        assertNotNull(cache.get(entries.first()))
        assertTrue(cache.root.listFiles()!!.count { it.extension == "jpg" } <= 3)
    }
    @Test fun modifiedLocalBytesLoseTheirIdentity() {
        val cache = ImageCache(temp.newFolder()); val e = entry("good".toByteArray())
        val cached = cache.install(e, metadata(e), { it.writeText("good") }, emptySet())
        cached.file.writeText("evil")
        assertNull(cache.get(e))
    }
}
