package house.rabbithole.nasa

import android.app.Application
import android.app.WallpaperManager
import android.content.Context
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.hardware.display.DisplayManager
import android.util.DisplayMetrics
import android.view.Display
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors

class NasaApp : Application() {
    val engine: WallpaperEngine by lazy { WallpaperEngine(this) }
}

enum class WallpaperAction { TEST, NEXT, AUTOMATIC, CURRENT }

class WallpaperEngine(private val context: Context) {
    val state = AppState(context)
    val cache = ImageCache(File(context.filesDir, "wallpapers"))
    private val executor = Executors.newSingleThreadExecutor()
    private val closer = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val gate = Any()
    init {
        if (state.operationInProgress) {
            state.operationInProgress = false
            state.status = "The last update was interrupted. Your current wallpaper stays available; try Next or wait for the slideshow."
        }
    }
    @Volatile private var active: WorkToken? = null
    val busy get() = active != null
    var onChanged: (() -> Unit)? = null // Activity attaches only while resumed.
    private fun changed() { handler.post { onChanged?.invoke() } }

    fun setIncludeLockScreen(include: Boolean): Boolean = synchronized(gate) {
        if (active != null) return@synchronized false
        state.includeLockScreen = include
        if (include && state.current.isNotEmpty()) run(WallpaperAction.CURRENT)
        else {
            state.status = if (include) "The next wallpaper will appear on your home and lock screens."
                else "Future changes use the home screen only. Your lock screen keeps its current image."
            changed()
            true
        }
    }

    fun pause() {
        synchronized(gate) {
            state.enabled = false
            active?.let { token -> token.cancelled = true; closer.execute { token.cancel() } }
            RotationJob.cancel(context)
            state.status = "Slideshow paused. Your current wallpaper stays in place."
        }
        changed()
    }
    fun stopWork() {
        synchronized(gate) {
            active?.let { token ->
                token.cancelled = true
                state.status = "Android stopped this update. Your current wallpaper stays in place; the slideshow will try again later."
                closer.execute { token.cancel() }
            }
        }
        changed()
    }
    fun save(settings: ConnectionSettings, done: (String?) -> Unit) {
        pause()
        executor.execute {
            val error = try {
                val previous = runCatching { state.settings().libraryKey() }.getOrNull()
                state.save(settings)
                if (previous != settings.libraryKey()) { cache.clear(); state.resetLibrary() }
                state.status = "Connection saved. Test it, then start your slideshow."
                null
            } catch (e: Exception) { safeError(e) }
            handler.post { done(error); onChanged?.invoke() }
        }
    }
    fun forget(done: () -> Unit) {
        pause()
        executor.execute { cache.clear(); state.forget(); handler.post { done(); onChanged?.invoke() } }
    }
    fun start() {
        try {
            val config = state.settings()
            if (!WallpaperManager.getInstance(context).isSetWallpaperAllowed) throw UserProblem("Android does not allow this app to set wallpaper on this device.")
            state.enabled = true
            if (!RotationJob.schedule(context, config.intervalMinutes)) {
                state.enabled = false
                throw UserProblem("Android could not schedule the slideshow. You can still set wallpapers manually.")
            }
            run(WallpaperAction.NEXT)
        } catch (e: Exception) { state.status = safeError(e); changed() }
    }
    fun run(action: WallpaperAction, finished: (() -> Unit)? = null): Boolean {
        val token = WorkToken()
        synchronized(gate) {
            if (active != null || (action == WallpaperAction.AUTOMATIC && !state.enabled)) return false
            active = token
            state.operationInProgress = true
        }
        state.status = if (action == WallpaperAction.TEST) "Checking both folders and a verified image…" else "Preparing the next NASA wallpaper…"
        changed()
        executor.execute {
            try {
                val settings = state.settings()
                if (action == WallpaperAction.CURRENT) {
                    val entry = cache.entries().firstOrNull { it.filename == state.current }
                    val image = entry?.let { cache.get(it) }
                        ?: throw UserProblem("The current photo is no longer cached. Tap Next wallpaper to update both screens.")
                    // Apply the exact current crop without network work or consuming a shuffle choice.
                    apply(image, cache.entries(), settings, token, online = false, fitWhole = state.currentFitWhole)
                    state.status = "Your current image is now on the home and lock screens."
                    return@execute
                }
                val network = allowedNetwork(settings.wifiOnly)
                var networkIssue: String? = null
                var selected: CachedImage? = null
                var applied = false
                var inventory = cache.entries()
                if (network != null) {
                    try {
                        SmbLibrary(settings, network, token).use { remote ->
                            val rawManifest = remote.manifest()
                            val fresh = Catalog.manifest(rawManifest)
                            if (fresh.isEmpty()) throw UserProblem("No finished 4K wallpapers were found in the publisher manifest.")
                            inventory = fresh
                            cache.saveManifest(rawManifest)
                            // A missing validation receipt must not block clean wallpaper rotation.
                            // Cached decisions expire; raw sourceUrl is never substituted for a known-bad page.
                            try { cache.saveSourceDecisions(remote.sourceDecisions()) }
                            catch (e: CancellationException) { throw e }
                            catch (_: Exception) { token.check() }
                            state.libraryCount = fresh.size
                            val names = state.bag.candidates(fresh.map { it.filename })
                            val firstPreview = state.preview.takeIf { state.current.isEmpty() && action != WallpaperAction.TEST && it in names }
                            val attempts = (listOfNotNull(firstPreview) + names).distinct().take(3)
                            var lastFailure: Exception? = null
                            for (name in attempts) {
                                token.check()
                                val entry = fresh.first { it.filename == name }
                                try {
                                    selected = cache.get(entry) ?: cache.install(entry, remote.metadata(entry), { remote.download(entry, it) }, setOf(state.current))
                                    break
                                } catch (e: CancellationException) { throw e }
                                catch (e: Exception) { token.check(); lastFailure = e }
                            }
                            val ready = selected ?: throw (lastFailure ?: UserProblem("No verified image could be read."))
                            token.check()
                            if (action == WallpaperAction.TEST) {
                                // Decode validation without changing either wallpaper surface.
                                WallpaperRenderer.render(ready.file, 360, 780, settings.fitWhole).recycle()
                                state.preview = ready.published.filename
                                state.status = "Connected · ${fresh.size} finished images. Preview ready; your wallpaper has not changed."
                            } else {
                                apply(ready, fresh, settings, token, online = true)
                                applied = true
                                state.status = "Wallpaper updated from your SMB collection."
                                changed()
                                // One small look-ahead download makes the next offline rotation useful.
                                val next = state.bag.candidates(fresh.map { it.filename }).firstOrNull { name -> name != ready.published.filename }
                                if (next != null) try {
                                    token.check()
                                    val entry = fresh.first { it.filename == next }
                                    if (cache.get(entry) == null) cache.install(entry, remote.metadata(entry), { remote.download(entry, it) }, setOf(ready.published.filename))
                                } catch (e: CancellationException) { throw e }
                                catch (_: Exception) { /* A successful wallpaper is not undone by optional prefetch failure. */ }
                            }
                        }
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) {
                        if (applied) token.check()
                        else networkIssue = safeError(e)
                    }
                } else networkIssue = if (settings.wifiOnly) "Wi-Fi is unavailable." else "No network is available."

                if (networkIssue != null) {
                    token.check()
                    if (action == WallpaperAction.TEST) throw UserProblem(networkIssue!!)
                    val cached = cache.cached().filter { it.published.filename != state.current }.shuffled().firstOrNull()
                    if (cached != null) {
                        apply(cached, inventory, settings, token, online = false)
                        state.status = "$networkIssue Using a verified cached image."
                    } else state.status = "$networkIssue Keeping the current wallpaper; no different cached image is available."
                }
            } catch (_: CancellationException) { /* Pause/onStopJob owns the visible state. */ }
            catch (e: Exception) { if (!token.cancelled) state.status = safeError(e) }
            finally {
                synchronized(gate) {
                    // Do not leave a failed first start repeatedly trying rejected credentials.
                    if (!token.cancelled && action != WallpaperAction.TEST && state.enabled && state.current.isEmpty()) {
                        state.enabled = false
                        RotationJob.cancel(context)
                        state.status += " Slideshow paused until a wallpaper can be set."
                    }
                    if (active === token) { active = null; state.operationInProgress = false }
                }
                changed()
                handler.post { finished?.invoke() }
            }
        }
        return true
    }

    private fun apply(image: CachedImage, inventory: List<PublishedImage>, settings: ConnectionSettings, token: WorkToken, online: Boolean,
                      fitWhole: Boolean = settings.fitWhole) {
        token.check()
        val (width, height) = screenSize()
        val bitmap = WallpaperRenderer.render(image.file, width, height, fitWhole)
        try {
            synchronized(gate) {
                token.check()
                val manager = WallpaperManager.getInstance(context)
                if (!manager.isWallpaperSupported || !manager.isSetWallpaperAllowed) throw UserProblem("Wallpaper changes are restricted by this device.")
                val includesLock = state.includeLockScreen
                val flags = WallpaperManager.FLAG_SYSTEM or if (includesLock) WallpaperManager.FLAG_LOCK else 0
                // One bitmap and one platform call keep both surfaces on the same clean image.
                val id = manager.setBitmap(bitmap, Rect(0, 0, bitmap.width, bitmap.height), false, flags)
                if (id <= 0) throw UserProblem("Android did not confirm the wallpaper change.")
                val lockId = if (includesLock) manager.getWallpaperId(WallpaperManager.FLAG_LOCK) else -1
                val bag = state.bag
                if (online) bag.markShown(image.published.filename, inventory.map { it.filename })
                else bag.last = image.published.filename
                state.shown(image, id, bag, fitWhole, includesLock, lockId)
            }
        } finally { bitmap.recycle() }
    }

    private fun allowedNetwork(wifiOnly: Boolean): Network? {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val active = cm.activeNetwork ?: return null
        val caps = cm.getNetworkCapabilities(active) ?: return null
        if (wifiOnly && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
        return active
    }

    fun currentMatchesSystem(): Boolean = state.currentWallpaperId > 0 &&
        runCatching {
            val manager = WallpaperManager.getInstance(context)
            manager.getWallpaperId(WallpaperManager.FLAG_SYSTEM) == state.currentWallpaperId &&
                (!state.currentIncludesLockScreen || manager.getWallpaperId(WallpaperManager.FLAG_LOCK) == state.currentLockWallpaperId)
        }.getOrDefault(false)

    @Suppress("DEPRECATION")
    fun screenSize(): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        val w = minOf(metrics.widthPixels, metrics.heightPixels).coerceAtLeast(1)
        val h = maxOf(metrics.widthPixels, metrics.heightPixels).coerceAtLeast(1)
        val scale = minOf(1f, 2160f / w, 3840f / h)
        return (w * scale).toInt().coerceAtLeast(1) to (h * scale).toInt().coerceAtLeast(1)
    }

    companion object {
        fun safeError(e: Exception): String {
            if (e is UserProblem) return e.message ?: "This operation could not be completed."
            val causes = generateSequence<Throwable>(e) { it.cause }.take(8).toList()
            val status = causes.filterIsInstance<com.hierynomus.mssmb2.SMBApiException>().firstOrNull()?.statusCode
            return when {
                status in listOf(0xc000006dL, 0xc000006aL, 0xc0000064L) -> "The PC rejected the SMB login. Check the sharing username and account password (not the Windows PIN)."
                status == 0xc0000022L -> "The SMB account cannot read this share or folder. Check its Windows read permissions."
                status == 0xc00000ccL -> "That SMB share name was not found. Check the first folder after the server address."
                status in listOf(0xc0000034L, 0xc000003aL, 0xc000000fL) -> "A shared folder or catalog file was not found. The catalog data folder must contain nasa-wallpaper/manifest.json."
                status == 0xc00000bbL -> "The server did not support the required encrypted SMB3 connection."
                causes.any { it is org.json.JSONException } -> "The shared JSON is incomplete or invalid. Check the catalog data folder."
                causes.any { it is java.net.UnknownHostException } -> "The SMB server could not be found. Check its address and Wi-Fi."
                causes.any { it is java.net.SocketTimeoutException } -> "The SMB server did not respond in time. Check that the PC is awake."
                causes.any { it is java.net.ConnectException || it is java.net.NoRouteToHostException } -> "The PC's SMB service is unreachable. Check the Wi-Fi network, PC address and Windows file sharing."
                else -> "The SMB connection could not complete (${causes.last().javaClass.simpleName}${status?.let { ": 0x" + it.toString(16) } ?: ""}). Check the saved connection."
            }
        }
    }
}
