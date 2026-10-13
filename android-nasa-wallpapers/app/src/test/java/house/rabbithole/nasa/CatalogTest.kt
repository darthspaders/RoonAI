package house.rabbithole.nasa

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class CatalogTest {
    private val hash = "a".repeat(64)
    private val name = "NASA-$hash.jpg"
    private fun manifest() = JSONObject().put("version", 1).put("files", JSONObject().put(name,
        JSONObject().put("sha256", hash).put("width", 3840).put("height", 2160).put("bytes", 1234).put("ids", JSONArray(listOf("nasa-science-42")))))
    private fun metadata() = JSONObject().put("id", "nasa-science-42").put("stage", "verified").put("presentationSha256", hash)
        .put("title", "A real catalog title").put("sourceWidth", 9000).put("sourceHeight", 5000)
        .put("sourceUrl", "https://science.nasa.gov/asset/webb/example/")
        .put("prepared", JSONObject().put("sourceDimensions", JSONArray(listOf(4800, 2667))).put("files", JSONObject().put("background-4k.jpg", hash)))
    @Test fun mapsPublishedHashToExistingRecord() {
        val entry = Catalog.manifest(manifest().toString()).single()
        val info = Catalog.metadata(metadata().toString(), entry, entry.ids.single())
        assertEquals("A real catalog title", info.title)
        assertEquals("nasa-science-42", info.id)
        assertNull(info.sourceUrl) // Raw catalog URLs are provenance, not validation evidence.
        assertTrue(info.originalResolution.contains("9"))
    }
    @Test fun neverIncludesMasksTemporariesOrUnverifiedSizes() {
        val root = manifest(); val files = root.getJSONObject("files")
        files.put("stars.png", files.getJSONObject(name)).put("../$name", files.getJSONObject(name)).put("$name.part", files.getJSONObject(name))
        assertEquals(1, Catalog.manifest(root.toString()).size)
        files.getJSONObject(name).put("width", 1920)
        assertTrue(Catalog.manifest(root.toString()).isEmpty())
    }
    @Test fun invalidCatalogIdCannotTraverseShare() {
        val root = manifest()
        root.getJSONObject("files").getJSONObject(name).put("ids", JSONArray(listOf("../secret", "folder/file")))
        assertTrue(Catalog.manifest(root.toString()).isEmpty())
    }
    @Test fun requiresMatchingFilenameAndHash() {
        val root = manifest(); root.getJSONObject("files").getJSONObject(name).put("sha256", "b".repeat(64))
        assertTrue(Catalog.manifest(root.toString()).isEmpty())
    }
    @Test fun rejectsWrongRecordOrUnfinishedMetadata() {
        val entry = Catalog.manifest(manifest().toString()).single()
        for ((key, value) in listOf("id" to "other", "stage" to "prepared", "presentationSha256" to "b".repeat(64))) {
            assertThrows(UserProblem::class.java) { Catalog.metadata(metadata().put(key, value).toString(), entry, entry.ids.single()) }
        }
        val row = metadata(); row.getJSONObject("prepared").getJSONObject("files").put("background-4k.jpg", "b".repeat(64))
        assertThrows(UserProblem::class.java) { Catalog.metadata(row.toString(), entry, entry.ids.single()) }
    }
    @Test fun refusesUnsupportedManifest() { assertThrows(UserProblem::class.java) { Catalog.manifest(manifest().put("version", 2).toString()) } }
    @Test fun boundsDownloadsEvenWithUntrustedLengths() {
        val out = ByteArrayOutputStream()
        assertThrows(UserProblem::class.java) { copyLimited(ByteArrayInputStream(ByteArray(300)), out, 200) }
        assertTrue(out.size() <= 200)
    }
    @Test fun cancellationStopsDownload() {
        assertThrows(IllegalStateException::class.java) { copyLimited(ByteArrayInputStream(ByteArray(100)), ByteArrayOutputStream(), 200) { error("cancelled") } }
    }
    @Test fun onlyExplicitHttpsNasaLinks() {
        assertNotNull(Catalog.nasaUrl("https://science.nasa.gov/a"))
        for (url in listOf("https://nasa.gov.evil.com/a", "http://nasa.gov/a", "https://user@nasa.gov/a", "javascript:alert(1)", "https://nasa.gov:8443/a")) assertNull(Catalog.nasaUrl(url))
    }
    @Test fun acceptsSpacesAndUncWithoutEmbeddedCredentials() {
        assertEquals("user/Pictures/Rabbit Hole NASA Wallpapers", ShareFolder.parse("smb://host/Users/user/Pictures/Rabbit Hole NASA Wallpapers").path)
        assertEquals("Users", ShareFolder.parse("\\\\host\\Users\\folder").share)
        for (path in listOf("smb://user:password@host/share", "smb://host/share/../file", "smb://host/share/a//b", "smb://host/share/%2e%2e"))
            assertThrows(UserProblem::class.java) { ShareFolder.parse(path) }
    }
    @Test fun noCredentialsInSettingsToString() {
        val settings = ConnectionSettings("smb://host/a", "smb://host/b", "user", "test-password", "")
        settings.validate()
        assertFalse(settings.toString().contains("test-password"))
    }
}
