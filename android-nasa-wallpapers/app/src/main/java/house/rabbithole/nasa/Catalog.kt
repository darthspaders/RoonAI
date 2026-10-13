package house.rabbithole.nasa

import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest

const val IMAGE_LIMIT = 16 * 1024 * 1024
const val METADATA_LIMIT = 256 * 1024
const val MANIFEST_LIMIT = 8 * 1024 * 1024
private val imagePattern = Regex("NASA-([a-f0-9]{64})\\.jpg")
private val idPattern = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,159}")

class UserProblem(message: String) : Exception(message)

data class ShareFolder(val host: String, val share: String, val path: String) {
    fun child(name: String): String = listOf(path, name).filter { it.isNotEmpty() }.joinToString("/")

    companion object {
        fun parse(text: String): ShareFolder {
            val value = text.trim().replace('\\', '/').let {
                if (it.startsWith("//")) "smb:$it" else it
            }
            val match = Regex("^smb://([A-Za-z0-9._-]+)/([^/]+)(?:/(.*))?$", RegexOption.IGNORE_CASE)
                .matchEntire(value) ?: throw UserProblem("Use smb://server/share/folder. Enter the account separately.")
            val share = match.groupValues[2]
            val path = match.groupValues[3].trimEnd('/')
            val parts = listOf(share) + if (path.isEmpty()) emptyList() else path.split('/')
            if (parts.any { it.isBlank() || it == "." || it == ".." || it.any { c -> c.code < 32 || c in ":*?\"<>|@%" } }) {
                throw UserProblem("Use the folder's actual names, with spaces, and no parent-directory shortcuts.")
            }
            return ShareFolder(match.groupValues[1], share, path)
        }
    }
}

// Deliberately not a data class: a generated toString() must never disclose credentials.
class ConnectionSettings(
    val wallpaperUrl: String, val catalogUrl: String,
    val username: String, val password: String, val domain: String,
    val intervalMinutes: Int = 60, val wifiOnly: Boolean = true, val fitWhole: Boolean = false
) {
    val wallpapers get() = ShareFolder.parse(wallpaperUrl)
    val catalog get() = ShareFolder.parse(catalogUrl)
    fun validate() {
        if (!wallpapers.host.equals(catalog.host, ignoreCase = true))
            throw UserProblem("Both folders must be on the same SMB server in this version.")
        if (username.isBlank() || password.isEmpty()) throw UserProblem("Enter the SMB username and password. A Windows PIN is not an SMB password.")
        if (intervalMinutes !in INTERVALS) throw UserProblem("Choose one of the supported wallpaper intervals.")
    }
    fun json() = JSONObject().put("wallpapers", wallpaperUrl).put("catalog", catalogUrl)
        .put("username", username).put("password", password).put("domain", domain)
        .put("interval", intervalMinutes).put("wifiOnly", wifiOnly).put("fitWhole", fitWhole).toString()
    fun libraryKey(): String = sha256((wallpapers.toString() + catalog.toString()).toByteArray())
    companion object {
        val INTERVALS = listOf(15, 30, 60, 180, 360, 720, 1440)
        fun fromJson(raw: String): ConnectionSettings {
            val j = JSONObject(raw)
            return ConnectionSettings(j.getString("wallpapers"), j.getString("catalog"), j.getString("username"),
                j.getString("password"), j.optString("domain"), j.optInt("interval", 60),
                j.optBoolean("wifiOnly", true), j.optBoolean("fitWhole", false)).also { it.validate() }
        }
    }
}

data class PublishedImage(val filename: String, val hash: String, val ids: List<String>, val bytes: Long)
data class NasaInfo(
    val id: String, val title: String, val target: String, val description: String,
    val mission: String, val credit: String, val publication: String, val dateKind: String,
    val originalResolution: String, val downloadResolution: String, val sourceUrl: String?, val sourceKind: String? = null
)

object Catalog {
    fun manifest(raw: String): List<PublishedImage> {
        if (raw.toByteArray().size > MANIFEST_LIMIT) throw UserProblem("The publisher manifest is too large.")
        val root = JSONObject(raw)
        if (root.optInt("version") != 1) throw UserProblem("The publisher manifest version is not supported.")
        val files = root.getJSONObject("files")
        if (files.length() > 20000) throw UserProblem("The wallpaper manifest exceeds this app's catalog limit.")
        return files.keys().asSequence().mapNotNull { name ->
            val hash = imagePattern.matchEntire(name)?.groupValues?.get(1) ?: return@mapNotNull null
            val row = files.optJSONObject(name) ?: return@mapNotNull null
            val ids = row.optJSONArray("ids") ?: return@mapNotNull null
            val safeIds = (0 until ids.length()).map { ids.optString(it) }.filter { idPattern.matches(it) }.distinct()
            if (row.optString("sha256") != hash || row.optInt("width") != 3840 || row.optInt("height") != 2160 ||
                row.optLong("bytes") !in 1..IMAGE_LIMIT.toLong() || safeIds.isEmpty()) return@mapNotNull null
            PublishedImage(name, hash, safeIds, row.getLong("bytes"))
        }.toList()
    }

    fun metadata(raw: String, image: PublishedImage, expectedId: String): NasaInfo {
        if (!idPattern.matches(expectedId) || expectedId !in image.ids || raw.toByteArray().size > METADATA_LIMIT)
            throw UserProblem("This image's catalog identity is invalid.")
        val row = JSONObject(raw)
        if (row.optString("id") != expectedId || row.optString("stage") != "verified" ||
            row.optString("presentationSha256") != image.hash ||
            row.optJSONObject("prepared")?.optJSONObject("files")?.optString("background-4k.jpg") != image.hash)
            throw UserProblem("The image and its verified catalog metadata do not match.")
        val title = clean(row.optString("title"))
        if (title.isBlank()) throw UserProblem("This catalog record has no image title.")
        val dims = row.optJSONObject("prepared")?.optJSONArray("sourceDimensions") ?: row.optJSONArray("sourceDimensions")
        return NasaInfo(expectedId, title, clean(row.optString("target")), clean(row.optString("description")),
            clean(row.optString("mission")), clean(row.optString("credit")), clean(row.optString("releaseDate")),
            clean(row.optString("dateKind")), resolution(row.optInt("sourceWidth"), row.optInt("sourceHeight")),
            resolution(dims?.optInt(0) ?: 0, dims?.optInt(1) ?: 0), null)
    }

    fun clean(value: String): String = value.replace(Regex("(?i)<\\s*(br\\s*/?|/p)\\s*>"), "\n")
        .replace(Regex("<[^>]*>"), "").replace("&nbsp;", " ").replace("&quot;", "\"")
        .replace("&hellip;", "…").replace("&ndash;", "–").replace("&mdash;", "—")
        .replace("&lsquo;", "‘").replace("&rsquo;", "’").replace("&ldquo;", "“").replace("&rdquo;", "”")
        .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        .replace(Regex("[\\t ]+"), " ").trim().take(30000)

    fun nasaUrl(value: String): String? = try {
        val uri = URI(value)
        val host = uri.host?.lowercase() ?: ""
        value.takeIf { uri.scheme == "https" && uri.userInfo == null && uri.port == -1 &&
            (host == "nasa.gov" || host.endsWith(".nasa.gov")) }
    } catch (_: Exception) { null }

    private fun resolution(w: Int, h: Int) = if (w > 0 && h > 0) "%,d × %,d px".format(w, h) else "Not recorded"
    fun validFilename(name: String) = imagePattern.matches(name)
}

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
fun fileHash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

fun copyLimited(input: InputStream, output: OutputStream, limit: Int, check: () -> Unit = {}) {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        check()
        val n = input.read(buffer)
        if (n < 0) break
        total += n
        if (total > limit) throw UserProblem("A shared file exceeds the safe download size.")
        output.write(buffer, 0, n)
    }
}
