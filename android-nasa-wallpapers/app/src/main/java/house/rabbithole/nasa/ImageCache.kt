package house.rabbithole.nasa

import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

data class CachedImage(val published: PublishedImage, val file: File, val info: NasaInfo)

/** At most three verified JPEG/JSON pairs; no masters, masks or independent catalog. */
class ImageCache(val root: File) {
    init { root.mkdirs() }
    private val manifestFile get() = File(root, "manifest.json")
    fun saveManifest(raw: String) { Catalog.manifest(raw); atomicText(manifestFile, raw) }
    fun saveSourceDecisions(raw: String) {
        require(raw.toByteArray().size <= MANIFEST_LIMIT && JSONObject(raw).optInt("version") == 1)
        atomicText(File(root, "source-links.json"), raw)
    }
    fun sourceDecision(id: String, hash: String): SourceDecision? = try {
        val file = File(root, "source-links.json")
        if (file.length() > MANIFEST_LIMIT) null else SourceDecisions.get(file.readText(), id, hash)
    } catch (_: Exception) { null }
    fun entries(): List<PublishedImage> = try { Catalog.manifest(manifestFile.readText()) } catch (_: Exception) { emptyList() }
    fun get(entry: PublishedImage): CachedImage? = try {
        require(Catalog.validFilename(entry.filename))
        val jpg = File(root, entry.filename)
        val json = File(root, entry.filename + ".json")
        if (!jpg.isFile || jpg.length() != entry.bytes || !json.isFile || json.length() > METADATA_LIMIT || fileHash(jpg) != entry.hash) null
        else {
            val raw = json.readText()
            val id = JSONObject(raw).getString("id")
            val source = sourceDecision(id, entry.hash)
            CachedImage(entry, jpg, Catalog.metadata(raw, entry, id).copy(sourceUrl = source?.url, sourceKind = source?.kind))
        }
    } catch (_: Exception) { null }

    fun install(entry: PublishedImage, rawMetadata: String, download: (File) -> Unit, protected: Set<String>): CachedImage {
        require(Catalog.validFilename(entry.filename))
        Catalog.metadata(rawMetadata, entry, JSONObject(rawMetadata).getString("id"))
        // Evict only expendable pairs before staging: three retained pairs + one bounded temporary JPEG.
        prune(protected, 2)
        val staged = File(root, "incoming.part")
        try {
            download(staged)
            if (staged.length() != entry.bytes || staged.length() > IMAGE_LIMIT || fileHash(staged) != entry.hash)
                throw UserProblem("The downloaded image did not match its publisher hash. The wallpaper was kept unchanged.")
            move(staged, File(root, entry.filename))
            atomicText(File(root, entry.filename + ".json"), rawMetadata)
        } finally { staged.delete() }
        val cached = get(entry) ?: throw UserProblem("The verified image could not be cached.")
        File(root, entry.filename).setLastModified(System.currentTimeMillis())
        prune(protected + entry.filename, 3)
        return cached
    }

    fun cached(): List<CachedImage> = entries().mapNotNull { get(it) }
    fun prune(protected: Set<String>, maxPairs: Int = 3) {
        val photos = root.listFiles()?.filter { Catalog.validFilename(it.name) }?.sortedByDescending { it.lastModified() } ?: emptyList()
        val keep = photos.filter { it.name in protected }.take(3).map { it.name }.toMutableSet()
        for (file in photos) if (keep.size < maxPairs) keep.add(file.name)
        for (file in photos) if (file.name !in keep) { file.delete(); File(root, file.name + ".json").delete() }
        root.listFiles()?.filter { it.name.endsWith(".part") || (it.name.endsWith(".jpg.json") && !File(root, it.name.removeSuffix(".json")).exists()) }
            ?.forEach { it.delete() }
    }
    fun clear() {
        // Only our fixed private cache directory, never a server path.
        root.listFiles()?.filter { it.isFile }?.forEach { it.delete() }
    }
    companion object {
        fun atomicText(destination: File, text: String) {
            val part = File(destination.parentFile, destination.name + ".part")
            try { part.outputStream().use { it.write(text.toByteArray()); it.fd.sync() }; move(part, destination) }
            finally { part.delete() }
        }
        private fun move(from: File, to: File) {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
